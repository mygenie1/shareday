#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift WidgetBridge plugin with Capacitor's bridge.
// Add to the main app target alongside WidgetBridge.swift.
CAP_PLUGIN(WidgetBridge, "WidgetBridge",
    CAP_PLUGIN_METHOD(setItem, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getItem, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(reloadAllTimelines, CAPPluginReturnPromise);
)
