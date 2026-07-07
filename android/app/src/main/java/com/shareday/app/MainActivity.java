package com.shareday.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WidgetBridgePlugin.class);   // app → widget bridge (SharedPreferences)
        super.onCreate(savedInstanceState);
    }
}
