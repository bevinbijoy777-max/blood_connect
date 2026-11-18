package com.bloodconnect.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * One screen: the live Blood Connect web app inside a WebView.
 *
 * The page does its own sign-in and data fetching, so this class only sets up
 * cookies and JavaScript, keeps links to other sites in the browser, and gives
 * the back gesture the web history it expects.
 */
public class MainActivity extends Activity {
    private static final String APP_URL = "https://site-69e3da5752364c3d893d669df627c833.freebuff.page/";
    private static final String APP_HOST = "site-69e3da5752364c3d893d669df627c833.freebuff.page";

    private static final String OFFLINE_HTML = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<body style='margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;"
            + "background:#0e1116;color:#e6edf3;font-family:system-ui,sans-serif;text-align:center'>"
            + "<div><h1 style='font-size:1.3rem'>Blood Connect</h1>"
            + "<p style='color:#9aa7b6'>No internet connection.</p>"
            + "<p><a style='color:#e5484d' href='" + APP_URL + "'>Try again</a></p></div></body>";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(Color.parseColor("#0e1116"));
            getWindow().setNavigationBarColor(Color.parseColor("#0e1116"));
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0e1116"));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // Sign-in returns to this host; anything else belongs in a browser.
                if (APP_HOST.equals(uri.getHost())) {
                    return false;
                }
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    view.loadDataWithBaseURL(null, OFFLINE_HTML, "text/html", "utf-8", null);
                }
            }
        });

        setContentView(web);
        web.loadUrl(APP_URL);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
