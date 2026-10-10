package dev.mazzen.remote

import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * This class is the whole reason this needs to be an app instead of a
 * website: it makes the HTTPS call to the TV directly from native code.
 *
 * The TV's local SmartCast API (https://<tv-ip>:9000/...) uses a
 * self-signed certificate whose name doesn't match its IP address, so a
 * normal strict HTTPS client (a browser, or a default Android connection)
 * refuses it. Browsers also block a "website" from calling it at all via
 * CORS. Neither of those rules apply to plain Kotlin code making its own
 * connection, which is what happens below. Trust is only relaxed for these
 * specific calls, never for anything else the app does, and this app only
 * ever talks to the IP address you type in on the Setup tab -- your own TV
 * on your own home network.
 */
class VizioBridge {

    private fun trustAllSslContext(): SSLContext {
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, trustAll, SecureRandom())
        return ctx
    }

    /**
     * Makes one request to the TV and returns a JSON string, always one of:
     *   {"ok":true,"status":200,"body":"...raw response text..."}
     *   {"ok":false,"error":"human readable reason"}
     * so the web UI never has to deal with a thrown exception.
     *
     * Called from JS as: VizioBridge.request(ip, method, path, bodyJson, authToken)
     * bodyJson/authToken may be empty strings when not needed.
     */
    @JavascriptInterface
    fun request(ip: String, method: String, path: String, bodyJson: String, authToken: String): String {
        return try {
            val url = URL("https://$ip:9000$path")
            val conn = url.openConnection() as HttpURLConnection

            if (conn is HttpsURLConnection) {
                // Explicit setter calls (not Kotlin property syntax) on purpose:
                // "SSL" being all-caps in setSSLSocketFactory breaks Kotlin's
                // getter/setter-to-property translation, so conn.sslSocketFactory = ...
                // would not actually call this setter.
                conn.setSSLSocketFactory(trustAllSslContext().socketFactory)
                conn.setHostnameVerifier(javax.net.ssl.HostnameVerifier { _, _ -> true })
            }

            conn.requestMethod = method
            conn.connectTimeout = 6000
            conn.readTimeout = 6000
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            if (authToken.isNotEmpty()) {
                conn.setRequestProperty("AUTH", authToken)
            }

            if (method == "PUT" || method == "POST") {
                conn.doOutput = true
                val writer = OutputStreamWriter(conn.outputStream, "UTF-8")
                writer.write(if (bodyJson.isNotEmpty()) bodyJson else "{}")
                writer.flush()
                writer.close()
            }

            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.let {
                val reader = BufferedReader(InputStreamReader(it, "UTF-8"))
                val sb = StringBuilder()
                var line: String?
                while (true) {
                    line = reader.readLine() ?: break
                    sb.append(line)
                }
                reader.close()
                sb.toString()
            } ?: ""

            val out = JSONObject()
            out.put("ok", status in 200..299)
            out.put("status", status)
            out.put("body", text)
            out.toString()
        } catch (e: Exception) {
            val out = JSONObject()
            out.put("ok", false)
            out.put("error", (e.javaClass.simpleName + ": " + (e.message ?: "unknown error")))
            out.toString()
        }
    }
}
