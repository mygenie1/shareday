package com.shareday.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin: the web app calls these to hand the widget its config
 * (SharedPreferences) and to request a refresh. The `group` arg (iOS App Group)
 * is ignored on Android — a fixed prefs file is used instead.
 * Registered in MainActivity via registerPlugin(WidgetBridgePlugin.class).
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(ShareDayWidgetProvider.PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void setItem(PluginCall call) {
        String key = call.getString("key");
        if (key == null) { call.reject("no key"); return; }
        String value = call.getString("value", "");
        prefs().edit().putString(key, value).apply();
        call.resolve();
    }

    @PluginMethod
    public void getItem(PluginCall call) {
        String key = call.getString("key");
        if (key == null) { call.reject("no key"); return; }
        JSObject ret = new JSObject();
        ret.put("value", prefs().getString(key, ""));
        call.resolve(ret);
    }

    @PluginMethod
    public void updateWidget(PluginCall call) {
        ShareDayWidgetProvider.requestUpdate(getContext());
        call.resolve();
    }
}
