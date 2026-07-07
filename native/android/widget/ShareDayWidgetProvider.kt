package com.shareday.app

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import org.json.JSONObject

/**
 * Home-screen widget. onUpdate/periodic refresh + a "next calendar" broadcast enqueue
 * a WidgetFetchWorker that does the network call off the main thread and updates the
 * RemoteViews. Reads the app-written config from SharedPreferences (PREFS/KEY).
 */
class ShareDayWidgetProvider : AppWidgetProvider() {

    companion object {
        const val PREFS = "shareday_widget_prefs"
        const val KEY = "shareday_widget"
        const val DEFAULT_BASE = "https://shareday-seven.vercel.app"
        const val ACTION_CYCLE = "com.shareday.app.WIDGET_CYCLE"

        fun requestUpdate(context: Context) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(ComponentName(context, ShareDayWidgetProvider::class.java))
            for (id in ids) enqueueFetch(context, id)
        }

        fun enqueueFetch(context: Context, widgetId: Int) {
            val req = OneTimeWorkRequestBuilder<WidgetFetchWorker>()
                .setInputData(workDataOf("widgetId" to widgetId))
                .build()
            WorkManager.getInstance(context).enqueue(req)
        }
    }

    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) enqueueFetch(context, id)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_CYCLE) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            prefs.getString(KEY, null)?.let { raw ->
                try {
                    val obj = JSONObject(raw)
                    val tokens = obj.getJSONArray("tokens")
                    if (tokens.length() > 1) {
                        val cur = obj.optInt("selectedIndex", 0)
                        obj.put("selectedIndex", (cur + 1) % tokens.length())
                        prefs.edit().putString(KEY, obj.toString()).apply()
                    }
                } catch (_: Exception) {}
            }
            requestUpdate(context)
        }
    }
}
