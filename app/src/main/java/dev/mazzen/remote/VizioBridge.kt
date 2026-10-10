package dev.mazzen.remote

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
import java.net.HttpURLConnection
import java.net.Inet4Address
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
class VizioBridge(private val webView: WebView) {

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
     * Scans the phone's local /24 network for anything listening on the
     * SmartCast ports. Result:
     *   {"ok":true,"subnet":"192.168.1","found":[{"ip":"192.168.1.40","port":7345,"name":"V505-J09"}]}
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

            val found = Collections.synchronizedList(mutableListOf<JSONObject>())
            val pool = Executors.newFixedThreadPool(48)
            for (i in 1..254) {
                val ip = "$prefix.$i"
                pool.execute {
                    for (port in intArrayOf(7345, 9000)) {
                        if (portOpen(ip, port)) {
                            found.add(JSONObject()
                                .put("ip", ip)
                                .put("port", port)
                                .put("name", deviceName("$ip:$port") ?: ""))
                            break
                        }
                    }
                }
            }
            pool.shutdown()
            pool.awaitTermination(30, TimeUnit.SECONDS)

            val arr = JSONArray()
            synchronized(found) { found.sortedBy { it.getString("ip").substringAfterLast('.').toInt() }.forEach { arr.put(it) } }
            deliver(cbId, JSONObject().put("ok", true).put("subnet", prefix).put("found", arr).toString())
        }.start()
    }

    private fun portOpen(ip: String, port: Int): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(ip, port), 450) }
        true
    } catch (e: Exception) {
        false
    }

    /** Best effort: SmartCast TVs usually answer deviceinfo without pairing. */
    private fun deviceName(host: String): String? = try {
        val res = JSONObject(request(host, "GET", "/state/device/deviceinfo", "", "", 1500))
        val body = res.optString("body", "")
        Regex("\"(?:NAME|MODEL_NAME)\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
    } catch (e: Exception) {
        null
    }

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

    @JavascriptInterface
    fun haptic() {
        main.post { webView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }
    }
}
