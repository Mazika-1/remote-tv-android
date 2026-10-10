package dev.mazzen.remote

import android.annotation.SuppressLint
import android.os.Bundle
import android.app.Activity
import android.webkit.WebSettings
import android.webkit.WebView

class MainActivity : Activity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true // needed so localStorage persists shows/settings

        // This is the important part: VizioBridge below is plain Kotlin code
        // making the actual network call to the TV. Because it is NOT the
        // WebView's own browser engine doing the request, none of the
        // website-vs-local-network browser restrictions apply to it.
        webView.addJavascriptInterface(VizioBridge(), "VizioBridge")

        webView.loadUrl("file:///android_asset/www/index.html")
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
