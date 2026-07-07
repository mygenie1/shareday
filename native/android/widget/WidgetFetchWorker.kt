package com.shareday.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.view.View
import android.widget.RemoteViews
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Does the network fetch and pushes the result into the widget's RemoteViews.
 * RemoteViews can't loop, so the layout has 4 fixed rows we show/hide.
 * PUBLIC snapshot only (GET /api/share/[token]).
 */
class WidgetFetchWorker(private val ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    private val rowIds = intArrayOf(R.id.row0, R.id.row1, R.id.row2, R.id.row3)
    private val dotIds = intArrayOf(R.id.dot0, R.id.dot1, R.id.dot2, R.id.dot3)
    private val titleIds = intArrayOf(R.id.title0, R.id.title1, R.id.title2, R.id.title3)
    private val timeIds = intArrayOf(R.id.time0, R.id.time1, R.id.time2, R.id.time3)

    override fun doWork(): Result {
        val widgetId = inputData.getInt("widgetId", -1)
        if (widgetId == -1) return Result.success()
        val mgr = AppWidgetManager.getInstance(ctx)
        val views = RemoteViews(ctx.packageName, R.layout.shareday_widget)

        // tap widget → open app
        ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let { open ->
            val pi = PendingIntent.getActivity(
                ctx, 0, open,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            views.setOnClickPendingIntent(R.id.widget_root, pi)
        }
        // "next calendar" button → broadcast to the provider
        val cycle = Intent(ctx, ShareDayWidgetProvider::class.java).apply {
            action = ShareDayWidgetProvider.ACTION_CYCLE
        }
        val cyclePi = PendingIntent.getBroadcast(
            ctx, 0, cycle,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        views.setOnClickPendingIntent(R.id.widget_cycle, cyclePi)

        val prefs = ctx.getSharedPreferences(ShareDayWidgetProvider.PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(ShareDayWidgetProvider.KEY, null)
        if (raw == null) {
            showMessage(views, "셰어데이", "위젯에 표시할 캘린더를 앱에서 골라 주세요.")
            mgr.updateAppWidget(widgetId, views); return Result.success()
        }

        try {
            val cfg = JSONObject(raw)
            val tokens = cfg.getJSONArray("tokens")
            if (tokens.length() == 0) {
                showMessage(views, "셰어데이", "위젯에 표시할 캘린더를 골라 주세요.")
                mgr.updateAppWidget(widgetId, views); return Result.success()
            }
            val idx = cfg.optInt("selectedIndex", 0).coerceIn(0, tokens.length() - 1)
            val ref = tokens.getJSONObject(idx)
            val token = ref.getString("token")
            val name = ref.optString("name", "공유 캘린더")
            val base = cfg.optString("base", ShareDayWidgetProvider.DEFAULT_BASE)
            views.setTextViewText(R.id.widget_title, name)
            views.setViewVisibility(R.id.widget_cycle, if (tokens.length() > 1) View.VISIBLE else View.GONE)

            val (code, body) = httpGet("$base/api/share/$token")
            if (code == 404 || code == 410) {
                showMessage(views, name, "링크가 만료됐어요.")
                mgr.updateAppWidget(widgetId, views); return Result.success()
            }
            if (body == null) { // network hiccup → leave last render
                mgr.updateAppWidget(widgetId, views); return Result.success()
            }

            val snap = JSONObject(body)
            val cats = HashMap<String, JSONObject>()
            snap.optJSONArray("categories")?.let {
                for (i in 0 until it.length()) { val c = it.getJSONObject(i); cats[c.getString("id")] = c }
            }
            val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
            val items = ArrayList<JSONObject>()
            snap.optJSONArray("events")?.let {
                for (i in 0 until it.length()) {
                    val e = it.getJSONObject(i)
                    if (e.optString("date") == today) items.add(e)
                }
            }
            items.sortBy { it.optString("time", "99") }

            if (items.isEmpty()) {
                showMessage(views, name, "오늘 공개된 일정이 없어요.")
            } else {
                views.setViewVisibility(R.id.widget_msg, View.GONE)
                for (i in 0 until 4) {
                    if (i < items.size) {
                        val e = items[i]
                        val c = cats[e.optString("catId")]
                        val time = if (e.isNull("time") || e.optString("time").isEmpty()) "종일"
                        else e.optString("time") + (if (e.optString("end").isNotEmpty()) "–" + e.optString("end") else "")
                        views.setViewVisibility(rowIds[i], View.VISIBLE)
                        views.setTextViewText(titleIds[i], e.optString("title", "제목 없음"))
                        views.setTextViewText(timeIds[i], time)
                        views.setInt(dotIds[i], "setColorFilter", safeColor(c?.optString("color")))
                    } else {
                        views.setViewVisibility(rowIds[i], View.GONE)
                    }
                }
                if (items.size > 4) {
                    views.setViewVisibility(R.id.widget_more, View.VISIBLE)
                    views.setTextViewText(R.id.widget_more, "+${items.size - 4}개 더")
                } else {
                    views.setViewVisibility(R.id.widget_more, View.GONE)
                }
            }
        } catch (e: Exception) {
            showMessage(views, "셰어데이", "잠시 후 다시 시도해요.")
        }
        mgr.updateAppWidget(widgetId, views)
        return Result.success()
    }

    private fun showMessage(views: RemoteViews, title: String, msg: String) {
        views.setTextViewText(R.id.widget_title, title)
        views.setViewVisibility(R.id.widget_msg, View.VISIBLE)
        views.setTextViewText(R.id.widget_msg, msg)
        for (id in rowIds) views.setViewVisibility(id, View.GONE)
        views.setViewVisibility(R.id.widget_more, View.GONE)
    }

    private fun safeColor(hex: String?): Int =
        try { Color.parseColor(hex ?: "#64748B") } catch (e: Exception) { Color.parseColor("#64748B") }

    private fun httpGet(urlStr: String): Pair<Int, String?> {
        return try {
            val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000; readTimeout = 8000; requestMethod = "GET"
            }
            val code = conn.responseCode
            val text = if (code in 200..299) conn.inputStream.bufferedReader().use { it.readText() } else null
            conn.disconnect()
            Pair(code, text)
        } catch (e: Exception) { Pair(0, null) }
    }
}
