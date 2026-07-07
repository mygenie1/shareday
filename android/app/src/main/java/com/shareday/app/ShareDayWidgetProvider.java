package com.shareday.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.work.Data;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONObject;

/**
 * Home-screen widget. onUpdate / periodic refresh / "next calendar" broadcast all
 * enqueue a WidgetFetchWorker that does the network call off the main thread and
 * updates the RemoteViews. Reads the app-written config from SharedPreferences.
 * PUBLIC snapshot only — private events never reach the server.
 */
public class ShareDayWidgetProvider extends AppWidgetProvider {

    public static final String PREFS = "shareday_widget_prefs";
    public static final String KEY = "shareday_widget";
    public static final String DEFAULT_BASE = "https://shareday-seven.vercel.app";
    public static final String ACTION_CYCLE = "com.shareday.app.WIDGET_CYCLE";

    public static void requestUpdate(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, ShareDayWidgetProvider.class));
        for (int id : ids) enqueueFetch(context, id);
    }

    public static void enqueueFetch(Context context, int widgetId) {
        Data data = new Data.Builder().putInt("widgetId", widgetId).build();
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(WidgetFetchWorker.class)
                .setInputData(data).build();
        WorkManager.getInstance(context).enqueue(req);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) enqueueFetch(context, id);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_CYCLE.equals(intent.getAction())) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = prefs.getString(KEY, null);
            if (raw != null) {
                try {
                    JSONObject obj = new JSONObject(raw);
                    int len = obj.getJSONArray("tokens").length();
                    if (len > 1) {
                        int cur = obj.optInt("selectedIndex", 0);
                        obj.put("selectedIndex", (cur + 1) % len);
                        prefs.edit().putString(KEY, obj.toString()).apply();
                    }
                } catch (Exception ignored) {}
            }
            requestUpdate(context);
        }
    }
}
