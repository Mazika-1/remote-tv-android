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
            val prefix = localSubnetPrefix()
            if (prefix == null) {
                deliver(cbId, JSONObject().put("ok", false)
                    .put("error", "Couldn't find this phone's WiFi address. Is WiFi on?").toString())
                return@Thread
            }

            val ssdpNames = Collections.synchronizedMap(mutableMapOf<String, Pair<String, String>>())
            val ssdp = Thread { ssdpDiscover(ssdpNames) }.apply { start() }

            val open = Collections.synchronizedList(mutableListOf<Pair<String, Int>>())
            val pool = Executors.newFixedThreadPool(48)
            for (i in 1..254) {
                val ip = "$prefix.$i"
                pool.execute {
                    for (port in intArrayOf(7345, 9000)) {
                        if (portOpen(ip, port)) { open.add(ip to port); break }
                    }
                }
            }
            pool.shutdown()
            pool.awaitTermination(30, TimeUnit.SECONDS)
            ssdp.join(6000)

            val arr = JSONArray()
            synchronized(open) { open.sortedBy { it.first.substringAfterLast('.').toInt() } }.forEach { (ip, port) ->
                var (name, model) = ssdpNames[ip] ?: ("" to "")
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

    private fun portOpen(ip: String, port: Int): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(ip, port), 450) }
        true
    } catch (e: Exception) {
        false
    }

    /** Sends SSDP M-SEARCH and reads friendlyName/modelName from each device description. */
    private fun ssdpDiscover(out: MutableMap<String, Pair<String, String>>) {
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
            out[ip] = name to (xmlTag(xml, "modelName") ?: "")
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

    private fun localSubnetPrefix(): String? {
        return try {
            val candidates = NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
            for (nif in candidates) {
                for (addr in nif.inetAddresses) {
                    if (addr is Inet4Address && addr.isSiteLocalAddress) {
                        return addr.hostAddress?.substringBeforeLast('.')
                    }
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
