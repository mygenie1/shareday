import Foundation
import Capacitor
import WidgetKit

/// Capacitor plugin: the web app calls these to hand the widget its config
/// (App Group UserDefaults) and to ask WidgetKit to refresh. Add this file to the
/// main app target (App/), NOT the widget extension.
@objc(WidgetBridge)
public class WidgetBridge: CAPPlugin {

    @objc func setItem(_ call: CAPPluginCall) {
        guard let group = call.getString("group"),
              let key = call.getString("key"),
              let value = call.getString("value"),
              let defaults = UserDefaults(suiteName: group) else {
            call.reject("missing group/key/value or app group not configured"); return
        }
        defaults.set(value, forKey: key)
        call.resolve()
    }

    @objc func getItem(_ call: CAPPluginCall) {
        guard let group = call.getString("group"),
              let key = call.getString("key"),
              let defaults = UserDefaults(suiteName: group) else {
            call.reject("missing group/key or app group not configured"); return
        }
        call.resolve(["value": defaults.string(forKey: key) ?? ""])
    }

    @objc func reloadAllTimelines(_ call: CAPPluginCall) {
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }
}
