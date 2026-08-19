package com.kinesis.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * Kinesis is one self-contained HTML file that already ships its own touch
 * controls and WebGL renderer, so the app is a single full-screen WebView
 * pointed at it. There is no network use and no bridge to native code.
 */
public class MainActivity extends Activity {

    private WebView web;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        // A wave can run for minutes with no touch input while the player only
        // moves the stick; without this the screen dims mid-fight.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // The game starts its own audio on the first tap. Without this the
        // WebView blocks that until a separate gesture it never receives.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        // The page is 1.1MB and is reloaded from the APK every launch; caching
        // it a second time only costs storage.
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // Stop the WebView from applying its own text zoom to the HUD when the
        // device font size is set large.
        s.setTextZoom(100);

        // requestPointerLock and fullscreen come through the chrome client.
        web.setWebChromeClient(new WebChromeClient());
        // Matches --void in the game's own palette, so the frame before the
        // first paint is not white.
        web.setBackgroundColor(0xFF0A0912);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        setContentView(web);
        web.loadUrl("file:///android_asset/kinesis3d.html");
        goImmersive();
    }

    /** Hide the status and navigation bars; the HUD needs the whole screen. */
    private void goImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            web.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // The bars come back after a swipe or a dialog; put them away again.
        if (hasFocus) goImmersive();
    }

    @Override
    public void onBackPressed() {
        // The game is a single page, so back has nowhere to go and would
        // otherwise kill a run instantly. Send it to the background instead.
        moveTaskToBack(true);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Stops the render loop and audio while the app is not in front.
        web.onPause();
        web.pauseTimers();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.resumeTimers();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
