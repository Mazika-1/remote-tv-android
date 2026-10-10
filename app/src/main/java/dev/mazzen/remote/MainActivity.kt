package dev.mazzen.remote

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.webkit.WebView

class MainActivity : Activity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val bg = Color.parseColor("#0B0D12")
        window.statusBarColor = bg
        window.navigationBarColor = bg

        webView = WebView(this)
        webView.setBackgroundColor(bg) // no white flash while the page loads
        webView.isVerticalScrollBarEnabled = false
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true // localStorage keeps shows/settings

        // VizioBridge is plain Kotlin making the network calls to the TV, so
        // none of the web page network restrictions apply to it.
        webView.addJavascriptInterface(VizioBridge(this, webView), "VizioBridge")

        webView.loadUrl("file:///android_asset/www/index.html")
    }

    override fun onResume() {
        super.onResume()
        // Lets the page re-check the nightly episode bump when you come back to the app.
        if (::webView.isInitialized) {
            webView.evaluateJavascript("window.onAppResume && window.onAppResume()", null)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Let the page close an open sheet / go back a step first.
        webView.evaluateJavascript("window.onAndroidBack ? window.onAndroidBack() : false") { handled ->
            if (handled != "true") {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }
}
