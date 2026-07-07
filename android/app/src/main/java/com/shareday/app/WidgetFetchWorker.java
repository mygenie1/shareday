package com.shareday.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.view.View;
import android.widget.RemoteViews;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;

/**
 * Network fetch (off main thread) → push into the widget RemoteViews.
 * RemoteViews can't loop, so the layout has 4 fixed rows we show/hide.
 * PUBLIC snapshot only (GET /api/share/[token]).
 */
public class WidgetFetchWorker extends Worker {

    private final int[] rowIds = { R.id.row0, R.id.row1, R.id.row2, R.id.row3 };
    private final int[] dotIds = { R.id.dot0, R.id.dot1, R.id.dot2, R.id.dot3 };
    private final int[] titleIds = { R.id.title0, R.id.title1, R.id.title2, R.id.title3 };
    private final int[] timeIds = { R.id.time0, R.id.time1, R.id.time2, R.id.time3 };
    private final Context ctx;

    public WidgetFetchWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
        this.ctx = context;
    }

    @NonNull
    @Override
    public Result doWork() {
        int widgetId = getInputData().getInt("widgetId", -1);
        if (widgetId == -1) return Result.success();
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.shareday_widget);

        // tap widget → open app
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open != null) {
            PendingIntent pi = PendingIntent.getActivity(ctx, 0, open,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            views.setOnClickPendingIntent(R.id.widget_root, pi);
        }
        // "next calendar" button → broadcast to provider
        Intent cycle = new Intent(ctx, ShareDayWidgetProvider.class);
        cycle.setAction(ShareDayWidgetProvider.ACTION_CYCLE);
        PendingIntent cyclePi = PendingIntent.getBroadcast(ctx, 0, cycle,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        views.setOnClickPendingIntent(R.id.widget_cycle, cyclePi);

        SharedPreferences prefs = ctx.getSharedPreferences(ShareDayWidgetProvider.PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(ShareDayWidgetProvider.KEY, null);
        if (raw == null) {
            showMessage(views, "셰어데이", "위젯에 표시할 캘린더를 앱에서 골라 주세요.");
            mgr.updateAppWidget(widgetId, views);
            return Result.success();
        }
        try {
            JSONObject cfg = new JSONObject(raw);
            JSONArray tokens = cfg.getJSONArray("tokens");
            if (tokens.length() == 0) {
                showMessage(views, "셰어데이", "위젯에 표시할 캘린더를 골라 주세요.");
                mgr.updateAppWidget(widgetId, views);
                return Result.success();
            }
            int idx = Math.max(0, Math.min(cfg.optInt("selectedIndex", 0), tokens.length() - 1));
            JSONObject ref = tokens.getJSONObject(idx);
            String token = ref.getString("token");
            String name = ref.optString("name", "공유 캘린더");
            String base = cfg.optString("base", ShareDayWidgetProvider.DEFAULT_BASE);
            views.setTextViewText(R.id.widget_title, name);
            views.setViewVisibility(R.id.widget_cycle, tokens.length() > 1 ? View.VISIBLE : View.GONE);

            int[] codeOut = new int[1];
            String body = httpGet(base + "/api/share/" + token, codeOut);
            int code = codeOut[0];
            if (code == 404 || code == 410) {
                showMessage(views, name, "링크가 만료됐어요.");
                mgr.updateAppWidget(widgetId, views);
                return Result.success();
            }
            if (body == null) { // network hiccup → keep last render
                mgr.updateAppWidget(widgetId, views);
                return Result.success();
            }

            JSONObject snap = new JSONObject(body);
            HashMap<String, JSONObject> cats = new HashMap<>();
            JSONArray catsArr = snap.optJSONArray("categories");
            if (catsArr != null) {
                for (int i = 0; i < catsArr.length(); i++) {
                    JSONObject c = catsArr.getJSONObject(i);
                    cats.put(c.getString("id"), c);
                }
            }
            String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            ArrayList<JSONObject> items = new ArrayList<>();
            JSONArray evs = snap.optJSONArray("events");
            if (evs != null) {
                for (int i = 0; i < evs.length(); i++) {
                    JSONObject e = evs.getJSONObject(i);
                    if (today.equals(e.optString("date"))) items.add(e);
                }
            }
            Collections.sort(items, new Comparator<JSONObject>() {
                public int compare(JSONObject a, JSONObject b) {
                    return a.optString("time", "99").compareTo(b.optString("time", "99"));
                }
            });

            if (items.isEmpty()) {
                showMessage(views, name, "오늘 공개된 일정이 없어요.");
            } else {
                views.setViewVisibility(R.id.widget_msg, View.GONE);
                for (int i = 0; i < 4; i++) {
                    if (i < items.size()) {
                        JSONObject e = items.get(i);
                        JSONObject c = cats.get(e.optString("catId"));
                        String time;
                        if (e.isNull("time") || e.optString("time").isEmpty()) time = "종일";
                        else time = e.optString("time") + (e.optString("end").isEmpty() ? "" : "–" + e.optString("end"));
                        views.setViewVisibility(rowIds[i], View.VISIBLE);
                        views.setTextViewText(titleIds[i], e.optString("title", "제목 없음"));
                        views.setTextViewText(timeIds[i], time);
                        views.setInt(dotIds[i], "setColorFilter", safeColor(c == null ? null : c.optString("color")));
                    } else {
                        views.setViewVisibility(rowIds[i], View.GONE);
                    }
                }
                if (items.size() > 4) {
                    views.setViewVisibility(R.id.widget_more, View.VISIBLE);
                    views.setTextViewText(R.id.widget_more, "+" + (items.size() - 4) + "개 더");
                } else {
                    views.setViewVisibility(R.id.widget_more, View.GONE);
                }
            }
        } catch (Exception e) {
            showMessage(views, "셰어데이", "잠시 후 다시 시도해요.");
        }
        mgr.updateAppWidget(widgetId, views);
        return Result.success();
    }

    private void showMessage(RemoteViews views, String title, String msg) {
        views.setTextViewText(R.id.widget_title, title);
        views.setViewVisibility(R.id.widget_msg, View.VISIBLE);
        views.setTextViewText(R.id.widget_msg, msg);
        for (int id : rowIds) views.setViewVisibility(id, View.GONE);
        views.setViewVisibility(R.id.widget_more, View.GONE);
    }

    private int safeColor(String hex) {
        try {
            return Color.parseColor(hex == null ? "#64748B" : hex);
        } catch (Exception e) {
            return Color.parseColor("#64748B");
        }
    }

    private String httpGet(String urlStr, int[] codeOut) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            codeOut[0] = code;
            if (code >= 200 && code < 300) {
                BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
                return sb.toString();
            }
            return null;
        } catch (Exception e) {
            codeOut[0] = 0;
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
