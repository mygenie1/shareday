# Adds the home-screen widget extension to the Capacitor-generated Xcode project.
#
# `npx cap add ios` produces a project with a single App target, and Xcode is the
# only supported way to add a second one — which is no help on Windows. So the target
# is described here instead, and the resulting project.pbxproj is committed.
#
# The script is IDEMPOTENT: it creates what is missing and re-applies settings on
# every run, so it is safe to re-run after a cap regeneration or a settings change.
# It edits the project in place; nothing here needs Xcode or a Mac.
#
#   gem install xcodeproj
#   ruby scripts/ios-add-widget-target.rb
#
# Fallback when there is no local Ruby: run the exact same command on Codemagic's
# macOS runner (Ruby + xcodeproj are preinstalled there) right after `npx cap sync
# ios`. Idempotence means local and CI converge on the same project.
#
# The Swift sources stay in native/ios/ and are referenced from there — no copies, so
# the widget code has exactly one home.

require 'xcodeproj'

ROOT         = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(ROOT, 'ios', 'App', 'App.xcodeproj')
APP_TARGET   = 'App'
WIDGET_TARGET = 'ShareDayWidgetExtension'
APP_BUNDLE_ID = 'com.mygenie.shareday'
WIDGET_BUNDLE_ID = "#{APP_BUNDLE_ID}.ShareDayWidget"
DEPLOYMENT_TARGET = '17.0'   # AppIntentConfiguration + interactive widgets

# paths are relative to the project dir (ios/App), which is what Xcode resolves
# SOURCE_ROOT to
BRIDGE_SOURCES = [
  '../../native/ios/App/WidgetBridge.swift',
  '../../native/ios/App/WidgetBridge.m',
].freeze
WIDGET_SOURCES = [
  '../../native/ios/ShareDayWidget/WidgetData.swift',
  '../../native/ios/ShareDayWidget/ShareDayWidget.swift',
].freeze
APP_ENTITLEMENTS    = '../../native/ios/App/App.entitlements'
WIDGET_ENTITLEMENTS = '../../native/ios/ShareDayWidget/ShareDayWidget.entitlements'
WIDGET_INFO_PLIST   = '../../native/ios/ShareDayWidget/Info.plist'

abort "not found: #{PROJECT_PATH} — run `npx cap add ios` first" unless Dir.exist?(PROJECT_PATH)

project = Xcodeproj::Project.open(PROJECT_PATH)
app = project.targets.find { |t| t.name == APP_TARGET } or abort "no #{APP_TARGET} target"

def group_for(project, name)
  project.main_group[name] || project.main_group.new_group(name)
end

# add a file to a group + a target's compile phase, unless it is already there
def ensure_source(project, group, target, path)
  ref = group.files.find { |f| f.path == path } || group.new_reference(path)
  already = target.source_build_phase.files_references.include?(ref)
  target.source_build_phase.add_file_reference(ref) unless already
  ref
end

changed = []

# ── 1. the app target compiles the WidgetBridge plugin (app ↔ widget over the App Group)
bridge_group = group_for(project, 'WidgetBridge')
BRIDGE_SOURCES.each do |path|
  before = app.source_build_phase.files.size
  ensure_source(project, bridge_group, app, path)
  changed << "app source: #{path}" if app.source_build_phase.files.size > before
end

# ── 2. the widget extension target
widget = project.targets.find { |t| t.name == WIDGET_TARGET }
if widget.nil?
  widget = project.new_target(:app_extension, WIDGET_TARGET, :ios, DEPLOYMENT_TARGET)
  changed << "created target #{WIDGET_TARGET}"
end

widget_group = group_for(project, 'ShareDayWidget')
WIDGET_SOURCES.each do |path|
  before = widget.source_build_phase.files.size
  ensure_source(project, widget_group, widget, path)
  changed << "widget source: #{path}" if widget.source_build_phase.files.size > before
end
# the Info.plist/entitlements are settings, not compiled input — reference them so they
# show up in Xcode, but keep them out of every build phase
[WIDGET_INFO_PLIST, WIDGET_ENTITLEMENTS].each do |path|
  widget_group.new_reference(path) unless widget_group.files.any? { |f| f.path == path }
end

# The widget's version MUST match the app's or App Store Connect rejects the upload,
# so mirror whatever the app target is set to rather than hardcoding it here.
app_release = app.build_configurations.find { |c| c.name == 'Release' } || app.build_configurations.first
marketing = app_release.build_settings['MARKETING_VERSION'] || '1.0'
current   = app_release.build_settings['CURRENT_PROJECT_VERSION'] || '1'

widget.build_configurations.each do |config|
  config.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER'    => WIDGET_BUNDLE_ID,
    'PRODUCT_NAME'                 => '$(TARGET_NAME)',
    'INFOPLIST_FILE'               => WIDGET_INFO_PLIST,
    'GENERATE_INFOPLIST_FILE'      => 'NO',
    'CODE_SIGN_ENTITLEMENTS'       => WIDGET_ENTITLEMENTS,
    'IPHONEOS_DEPLOYMENT_TARGET'   => DEPLOYMENT_TARGET,
    'SWIFT_VERSION'                => '5.0',
    'TARGETED_DEVICE_FAMILY'       => '1,2',
    'SKIP_INSTALL'                 => 'YES',
    'MARKETING_VERSION'            => marketing,
    'CURRENT_PROJECT_VERSION'      => current,
    'LD_RUNPATH_SEARCH_PATHS'      => '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks',
  )
end

# ── 3. the app target: bundle id + the App Group entitlement (the web shell writes the
#       snapshot through WidgetBridge, so the app needs the same container as the widget).
#       The bundle id is owned here, not in the pbxproj, so that changing it in one
#       place and re-running keeps the app and the widget in step.
app.build_configurations.each do |config|
  if config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] != APP_BUNDLE_ID
    config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = APP_BUNDLE_ID
    changed << "app bundle id (#{config.name}) → #{APP_BUNDLE_ID}"
  end
  unless config.build_settings['CODE_SIGN_ENTITLEMENTS'] == APP_ENTITLEMENTS
    config.build_settings['CODE_SIGN_ENTITLEMENTS'] = APP_ENTITLEMENTS
    changed << "app entitlements (#{config.name})"
  end
end
app_group = project.main_group['App'] || project.main_group
unless app_group.files.any? { |f| f.path == APP_ENTITLEMENTS }
  app_group.new_reference(APP_ENTITLEMENTS)
end

# ── 4. embed the extension in the app + build it first
unless app.dependencies.any? { |d| d.target == widget }
  app.add_dependency(widget)
  changed << 'target dependency App → widget'
end

embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' }
if embed.nil?
  embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
  embed.symbol_dst_subfolder_spec = :plug_ins
  changed << 'copy-files phase: Embed Foundation Extensions'
end
unless embed.files_references.include?(widget.product_reference)
  build_file = embed.add_file_reference(widget.product_reference)
  build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  changed << 'embedded widget product'
end

project.save

puts changed.empty? ? 'nothing to do — project already has the widget target (idempotent)' : "applied:\n  - #{changed.join("\n  - ")}"
puts "targets now: #{project.targets.map(&:name).join(', ')}"
