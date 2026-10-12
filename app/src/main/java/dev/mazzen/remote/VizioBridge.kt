package dev.mazzen.remote

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Native side of the app: makes the HTTPS calls to the TV, scans the WiFi
 * network for it, and gives haptic feedback.
 *
 * The TV's local SmartCast API (https://<tv-ip>:7345 on newer firmware,
 * :9000 on older) uses a self-signed certificate whose name doesn't match its
 * IP address, so a normal strict HTTPS client refuses it, and browsers block
 * a web page from calling it at all. Plain Kotlin code making its own
 * connection isn't subject to either rule. Trust is only relaxed for these
 * calls to the TV on your own network, never for anything else.
 *
 * All network work runs off the UI thread. JS calls the *Async methods with
 * a callback id, and the result comes back via window.__nativeCb(id, json).
 */
class VizioBridge(private val context: Context, private val webView: WebView) {

    private val main = Handler(Looper.getMainLooper())

    // Single thread so remote key presses reach the TV in the order tapped.
    private val requestQueue = Executors.newSingleThreadExecutor()

    private val sslContext: SSLContext by lazy {
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        SSLContext.getInstance("TLS").apply { init(null, trustAll, SecureRandom()) }
    }

    private fun deliver(cbId: String, json: String) {
        main.post {
            webView.evaluateJavascript(
                "window.__nativeCb && window.__nativeCb(${JSONObject.quote(cbId)}, ${JSONObject.quote(json)})",
                null
            )
        }
    }

    /**
     * Queues one request to the TV. Result (always one of):
     *   {"ok":true,"status":200,"body":"...raw response text..."}
     *   {"ok":false,"status":401,"body":"..."}
     *   {"ok":false,"error":"human readable reason"}
     *
     * host is "ip:port". bodyJson/authToken may be empty strings.
     */
    @JavascriptInterface
    fun requestAsync(cbId: String, host: String, method: String, path: String, bodyJson: String, authToken: String, timeoutMs: Int) {
        requestQueue.execute {
            deliver(cbId, request(host, method, path, bodyJson, authToken, timeoutMs))
        }
    }

    private fun request(host: String, method: String, path: String, bodyJson: String, authToken: String, timeoutMs: Int): String {
        return try {
            val conn = URL("https://$host$path").openConnection() as HttpURLConnection

            if (conn is HttpsURLConnection) {
                // Explicit setter calls (not Kotlin property syntax) on purpose:
                // "SSL" being all-caps in setSSLSocketFactory breaks Kotlin's
                // getter/setter-to-property translation.
                conn.setSSLSocketFactory(sslContext.socketFactory)
                conn.setHostnameVerifier { _, _ -> true }
            }

            val timeout = if (timeoutMs > 0) timeoutMs else 5000
            conn.requestMethod = method
            conn.connectTimeout = timeout
            conn.readTimeout = timeout
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            if (authToken.isNotEmpty()) conn.setRequestProperty("AUTH", authToken)

            if (method == "PUT" || method == "POST") {
                conn.doOutput = true
                OutputStreamWriter(conn.outputStream, "UTF-8").use {
                    it.write(if (bodyJson.isNotEmpty()) bodyJson else "{}")
                }
            }

            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.let { s ->
                BufferedReader(InputStreamReader(s, "UTF-8")).use { it.readText() }
            } ?: ""

            JSONObject()
                .put("ok", status in 200..299)
                .put("status", status)
                .put("body", text)
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", e.javaClass.simpleName + ": " + (e.message ?: "unknown error"))
                .toString()
        }
    }

    /**
     * Finds Vizio TVs on the WiFi. Two methods run together:
     *  - a port scan of the phone's /24 network for the SmartCast ports
     *    (this is what decides something is a Vizio TV), and
     *  - SSDP/UPnP discovery, which gives the name you gave the TV in its
     *    settings (e.g. "Living Room TV").
     * Result:
     *   {"ok":true,"subnet":"192.168.1","found":[{"ip":"192.168.1.40","port":7345,"name":"Living Room","model":"V505-J09"}]}
     */
    @JavascriptInterface
    fun scanAsync(cbId: String) {
        Thread {
            val net = localNetwork()
            if (net == null) {
                deliver(cbId, JSONObject().put("ok", false)
                    .put("error", "Couldn't find this phone's WiFi address. Is WiFi on?").toString())
                return@Thread
            }

            val prefix = net.first
            val ssdpNames = Collections.synchronizedMap(mutableMapOf<String, Triple<String, String, String>>())
            val ssdp = Thread { ssdpDiscover(ssdpNames) }.apply { start() }

            // Every address on the network, not just the first TV that answers.
            val open = Collections.synchronizedList(mutableListOf<Pair<String, Int>>())
            val pool = Executors.newFixedThreadPool(64)
            for (ip in net.second) {
                pool.execute {
                    for (port in intArrayOf(7345, 9000)) {
                        if (portOpen(ip, port, 900)) { open.add(ip to port); break }
                    }
                }
            }
            pool.shutdown()
            pool.awaitTermination(45, TimeUnit.SECONDS)
            ssdp.join(6000)

            // TVs that announced themselves but were slow to answer the scan
            // (common in standby): check them again with more patience.
            val seen = synchronized(open) { open.map { it.first }.toSet() }
            for ((ip, info) in ssdpNames.toMap()) {
                if (ip in seen) continue
                val looksVizio = info.third.contains("vizio", ignoreCase = true) || info.second.matches(Regex("^[DEMPV]\\d.*"))
                if (!looksVizio) continue
                for (port in intArrayOf(7345, 9000)) {
                    if (portOpen(ip, port, 2500)) { open.add(ip to port); break }
                }
            }

            val arr = JSONArray()
            synchronized(open) { open.distinctBy { it.first }.sortedBy { ipNum(it.first) } }.forEach { (ip, port) ->
                val info = ssdpNames[ip]
                var name = info?.first ?: ""
                var model = info?.second ?: ""
                if (name.isEmpty()) {
                    castName(ip)?.let { name = it }
                }
                if (name.isEmpty() || model.isEmpty()) {
                    deviceInfo("$ip:$port")?.let { (n, m) ->
                        if (name.isEmpty()) name = n
                        if (model.isEmpty()) model = m
                    }
                }
                arr.put(JSONObject().put("ip", ip).put("port", port).put("name", name).put("model", model))
            }
            deliver(cbId, JSONObject().put("ok", true).put("subnet", prefix).put("found", arr).toString())
        }.start()
    }

    private fun ipNum(ip: String): Long = ip.split('.').fold(0L) { acc, p -> acc * 256 + (p.toLongOrNull() ?: 0) }

    private fun portOpen(ip: String, port: Int, timeout: Int): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(ip, port), timeout) }
        true
    } catch (e: Exception) {
        false
    }

    /** Sends SSDP M-SEARCH and reads friendlyName/modelName from each device description. */
    private fun ssdpDiscover(out: MutableMap<String, Triple<String, String, String>>) {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = try { wifi?.createMulticastLock("remotetv-ssdp")?.apply { setReferenceCounted(false); acquire() } } catch (e: Exception) { null }
        val locations = mutableMapOf<String, String>()
        try {
            DatagramSocket().use { sock ->
                sock.soTimeout = 400
                val group = InetAddress.getByName("239.255.255.250")
                for (st in listOf("urn:dial-multiscreen-org:service:dial:1", "upnp:rootdevice", "ssdp:all")) {
                    val msg = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: $st\r\n\r\n"
                    val bytes = msg.toByteArray()
                    sock.send(DatagramPacket(bytes, bytes.size, group, 1900))
                }
                val buf = ByteArray(4096)
                val end = System.currentTimeMillis() + 3000
                while (System.currentTimeMillis() < end) {
                    try {
                        val pkt = DatagramPacket(buf, buf.size)
                        sock.receive(pkt)
                        val ip = pkt.address.hostAddress ?: continue
                        val text = String(pkt.data, 0, pkt.length)
                        val loc = Regex("(?im)^location:\\s*(\\S+)").find(text)?.groupValues?.get(1) ?: continue
                        // Prefer the DIAL description (has the TV's own name) over others.
                        if (!locations.containsKey(ip) || text.contains("dial", ignoreCase = true)) locations[ip] = loc
                    } catch (e: SocketTimeoutException) {
                        // keep listening until the deadline
                    }
                }
            }
        } catch (e: Exception) {
            // discovery is best effort
        } finally {
            try { lock?.release() } catch (e: Exception) {}
        }
        for ((ip, loc) in locations) {
            val xml = httpGet(loc, 1500) ?: continue
            val name = xmlTag(xml, "friendlyName") ?: continue
            out[ip] = Triple(name, xmlTag(xml, "modelName") ?: "", xmlTag(xml, "manufacturer") ?: "")
        }
    }

    /** Vizio TVs have Chromecast built in; its description carries the TV's name. */
    private fun castName(ip: String): String? {
        val xml = httpGet("http://$ip:8008/ssdp/device-desc.xml", 1200) ?: return null
        return xmlTag(xml, "friendlyName")
    }

    private fun deviceInfo(host: String): Pair<String, String>? = try {
        val body = JSONObject(request(host, "GET", "/state/device/deviceinfo", "", "", 1500)).optString("body", "")
        val name = Regex("\"NAME\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1) ?: ""
        val model = Regex("\"MODEL_NAME\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1) ?: ""
        if (name.isEmpty() && model.isEmpty()) null else name to model
    } catch (e: Exception) {
        null
    }

    private fun httpGet(url: String, timeout: Int): String? = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = timeout
        conn.readTimeout = timeout
        if (conn.responseCode in 200..299) conn.inputStream.bufferedReader().use { it.readText() } else null
    } catch (e: Exception) {
        null
    }

    private fun xmlTag(xml: String, tag: String): String? =
        Regex("<$tag>([^<]+)</$tag>").find(xml)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }
            ?.replace("&amp;", "&")?.replace("&apos;", "'")?.replace("&quot;", "\"")

    /**
     * The phone's WiFi network: (display prefix, every host address on it).
     * Uses the real network size, so a /23 or /22 (common on mesh routers)
     * is fully covered. Capped at a /22 (1022 hosts) to keep the scan quick.
     */
    private fun localNetwork(): Pair<String, List<String>>? {
        return try {
            val candidates = NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
            for (nif in candidates) {
                for (ia in nif.interfaceAddresses) {
                    val addr = ia.address
                    if (addr !is Inet4Address || !addr.isSiteLocalAddress) continue
                    val bits = ia.networkPrefixLength.toInt().coerceIn(22, 30)
                    val b = addr.address
                    val ipInt = ((b[0].toInt() and 255) shl 24) or ((b[1].toInt() and 255) shl 16) or
                        ((b[2].toInt() and 255) shl 8) or (b[3].toInt() and 255)
                    val mask = -1 shl (32 - bits)
                    val base = ipInt and mask
                    val count = 1 shl (32 - bits)
                    val hosts = (1 until count - 1).map { i ->
                        val v = base + i
                        "${(v ushr 24) and 255}.${(v ushr 16) and 255}.${(v ushr 8) and 255}.${v and 255}"
                    }.filter { it != addr.hostAddress }
                    return (addr.hostAddress?.substringBeforeLast('.') ?: "") to hosts
                }
            }
            null
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Opens a link on the phone. Links like play.hbomax.com/... open straight
     * in that streaming service's own app if it's installed.
     */
    @JavascriptInterface
    fun openUrl(url: String): Boolean = try {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
    } catch (e: Exception) {
        false
    }

    /** Text currently on the clipboard (for the "Paste" button). */
    @JavascriptInterface
    fun clipboardText(): String {
        val latch = java.util.concurrent.CountDownLatch(1)
        var text = ""
        main.post {
            try {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
            } catch (e: Exception) {
            }
            latch.countDown()
        }
        latch.await(2, TimeUnit.SECONDS)
        return text
    }

    @JavascriptInterface
    fun haptic() {
        main.post { webView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }
    }
}
