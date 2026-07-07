package com.shareday.app

import android.content.Context
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor plugin: the web app calls these to hand the widget its config
 * (SharedPreferences) and to request a refresh. The `group` arg is ignored on
 * Android (iOS App Group only); a fixed prefs file is used instead.
 *
 * Register it in MainActivity: registerPlugin(WidgetBridgePlugin::class.java)
 */
@CapacitorPlugin(name = "WidgetBridge")
class WidgetBridgePlugin : Plugin() {

    private fun prefs() =
        context.getSharedPreferences(ShareDayWidgetProvider.PREFS, Context.MODE_PRIVATE)

    @PluginMethod
    fun setItem(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("no key")
        val value = call.getString("value") ?: ""
        prefs().edit().putString(key, value).apply()
        call.resolve()
    }

    @PluginMethod
    fun getItem(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("no key")
        val ret = JSObject()
        ret.put("value", prefs().getString(key, "") ?: "")
        call.resolve(ret)
    }

    @PluginMethod
    fun updateWidget(call: PluginCall) {
        ShareDayWidgetProvider.requestUpdate(context)
        call.resolve()
    }
}
