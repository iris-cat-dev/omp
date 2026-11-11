#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <cmath>
#include <initializer_list>
#include <node_api.h>
#include <string>

// Loaded only by the owned GUI process. Mouse input travels through NSApp and
// MiniElectronWindow; this never calls renderer methods or fabricates DOM input.
static NSString* Text(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a string");
    return nil;
  }
  std::string bytes(length + 1, '\0');
  napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length);
  return [[NSString alloc] initWithBytes:bytes.data() length:length encoding:NSUTF8StringEncoding];
}
static NSView* Renderer(NSView* view) {
  if ([NSStringFromClass(view.class) isEqualToString:@"MiniElectronRendererView"]) return view;
  for (NSView* child in view.subviews) if (NSView* found = Renderer(child)) return found;
  return nil;
}
static NSWindow* Window(napi_env env, napi_value title) {
  NSString* expected = Text(env, title);
  if (!expected) return nil;
  NSWindow* found = nil;
  for (NSWindow* window in NSApp.windows) {
    if (![window.title isEqualToString:expected]) continue;
    if (found) {
      napi_throw_error(env, nullptr, "Owned window title is not unique");
      return nil;
    }
    found = window;
  }
  if (!found || !Renderer(found.contentView)) {
    napi_throw_error(env, nullptr, "Owned native renderer window not found");
    return nil;
  }
  return found;
}
static CGFloat DesktopTop() { return NSMaxY(NSScreen.screens.firstObject.frame); }
static void Number(napi_env env, napi_value object, const char* name, double number) {
  napi_value value;
  napi_create_double(env, number, &value);
  napi_set_named_property(env, object, name, value);
}
static void SetBoolean(napi_env env, napi_value object, const char* name, bool flag) {
  napi_value value;
  napi_get_boolean(env, flag, &value);
  napi_set_named_property(env, object, name, value);
}
static void String(napi_env env, napi_value object, const char* name, NSString* text) {
  napi_value value;
  napi_create_string_utf8(env, text ? text.UTF8String : "", NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, name, value);
}
static napi_value Describe(napi_env env, NSWindow* window) {
  napi_value result;
  napi_create_object(env, &result);
  Number(env, result, "windowNumber", window ? window.windowNumber : 0);
  String(env, result, "title", window.title);
  SetBoolean(env, result, "ignoresMouseEvents", window.ignoresMouseEvents);
  SetBoolean(env, result, "canBecomeKey", window.canBecomeKeyWindow);
  SetBoolean(env, result, "isKey", window.isKeyWindow);
  SetBoolean(env, result, "visible", window.visible);
  String(env, result, "firstResponder", window.firstResponder ? NSStringFromClass(window.firstResponder.class) : @"");
  if (window) {
    NSView* view = Renderer(window.contentView);
    NSRect widget = [window convertRectToScreen:[view convertRect:view.bounds toView:nil]];
    Number(env, result, "x", NSMinX(widget));
    Number(env, result, "y", DesktopTop() - NSMaxY(widget));
    Number(env, result, "width", NSWidth(widget));
    Number(env, result, "height", NSHeight(widget));
    Number(env, result, "scale", window.backingScaleFactor);
  }
  return result;
}
static napi_value Geometry(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value title;
  napi_get_cb_info(env, info, &count, &title, nullptr, nullptr);
  if (count != 1) { napi_throw_type_error(env, nullptr, "geometry(title)"); return nullptr; }
  NSWindow* window = Window(env, title);
  return window ? Describe(env, window) : nullptr;
}
static bool Coordinates(napi_env env, napi_value xValue, napi_value yValue, double* x, double* y) {
  if (napi_get_value_double(env, xValue, x) != napi_ok ||
      napi_get_value_double(env, yValue, y) != napi_ok || !std::isfinite(*x) || !std::isfinite(*y)) {
    napi_throw_type_error(env, nullptr, "Expected finite desktop DIP coordinates");
    return false;
  }
  return true;
}
// AppKit hit-window lookup is independent of DOM alpha/geometry. Record native
// ignored windows too: those windows cannot receive clicks via NSWindow.sendEvent.
static NSWindow* Route(napi_env env, double x, double y, napi_value result) {
  const NSPoint point = NSMakePoint(x, DesktopTop() - y);
  NSInteger below = 0;
  napi_value skipped;
  napi_create_array(env, &skipped);
  uint32_t index = 0;
  for (NSUInteger turn = 0; turn < NSApp.windows.count + 1; ++turn) {
    const NSInteger number = [NSWindow windowNumberAtPoint:point belowWindowWithWindowNumber:below];
    if (!number || number == below) break;
    NSWindow* window = [NSApp windowWithWindowNumber:number];
    if (!window || !Renderer(window.contentView)) {
      NSString* message = [NSString stringWithFormat:@"AppKit hit target is not an owned renderer window; refusing input (hit=%ld, owned=%@, key=%ld)", (long)number, [NSApp.windows valueForKey:@"windowNumber"], (long)NSApp.keyWindow.windowNumber];
      napi_throw_error(env, nullptr, message.UTF8String);
      return nil;
    }
    if (!window.ignoresMouseEvents) {
      napi_set_named_property(env, result, "recipient", Describe(env, window));
      napi_set_named_property(env, result, "ignored", skipped);
      return window;
    }
    napi_set_element(env, skipped, index++, Describe(env, window));
    below = number;
  }
  napi_throw_error(env, nullptr, "No owned AppKit mouse recipient at this screen point");
  return nil;
}
static napi_value Hit(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], result;
  double x = 0, y = 0;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2 || !Coordinates(env, args[0], args[1], &x, &y)) return nullptr;
  napi_create_object(env, &result);
  return Route(env, x, y, result) ? result : nullptr;
}
static napi_value Warp(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], result;
  double x = 0, y = 0;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2 || !Coordinates(env, args[0], args[1], &x, &y)) return nullptr;
  if (CGWarpMouseCursorPosition(CGPointMake(x, y)) != kCGErrorSuccess) {
    napi_throw_error(env, nullptr, "Cannot move the native cursor");
    return nullptr;
  }
  const NSPoint actual = NSEvent.mouseLocation;
  napi_create_object(env, &result);
  Number(env, result, "x", actual.x);
  Number(env, result, "y", DesktopTop() - actual.y);
  return result;
}
static NSWindow* heldWindow = nil;
static napi_value Mouse(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], result;
  double x = 0, y = 0;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 3 || !Coordinates(env, args[1], args[2], &x, &y)) return nullptr;
  NSString* type = Text(env, args[0]);
  if (!type) return nullptr;
  NSEventType eventType;
  if ([type isEqualToString:@"move"]) eventType = NSEventTypeMouseMoved;
  else if ([type isEqualToString:@"down"]) eventType = NSEventTypeLeftMouseDown;
  else if ([type isEqualToString:@"drag"]) eventType = NSEventTypeLeftMouseDragged;
  else if ([type isEqualToString:@"up"]) eventType = NSEventTypeLeftMouseUp;
  else { napi_throw_type_error(env, nullptr, "Unknown native mouse type"); return nullptr; }
  napi_create_object(env, &result);
  const bool captured = eventType == NSEventTypeLeftMouseDragged || eventType == NSEventTypeLeftMouseUp;
  NSWindow* window = captured ? heldWindow : Route(env, x, y, result);
  if (!window) {
    if (captured) napi_throw_error(env, nullptr, "No native down window owns this drag/release");
    return nullptr;
  }
  if (captured) napi_set_named_property(env, result, "recipient", Describe(env, window));
  SetBoolean(env, result, "captured", captured);
  if (eventType == NSEventTypeLeftMouseDown) heldWindow = window;
  const NSPoint point = [window convertPointFromScreen:NSMakePoint(x, DesktopTop() - y)];
  NSEvent* event = [NSEvent mouseEventWithType:eventType location:point modifierFlags:0
      timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
      context:nil eventNumber:0 clickCount:eventType == NSEventTypeMouseMoved ? 0 : 1
      pressure:eventType == NSEventTypeLeftMouseDown || eventType == NSEventTypeLeftMouseDragged ? 1 : 0];
  CGEventSetLocation(event.CGEvent, CGPointMake(x, y));
  [NSApp sendEvent:event];
  if (eventType == NSEventTypeLeftMouseUp) heldWindow = nil;
  Number(env, result, "x", x);
  Number(env, result, "y", y);
  return result;
}
static napi_value Key(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value value, result;
  napi_get_cb_info(env, info, &count, &value, nullptr, nullptr);
  NSString* text = count == 1 ? Text(env, value) : nil;
  NSWindow* window = NSApp.keyWindow;
  if (!text || text.length != 1 || !window || !Renderer(window.contentView)) {
    napi_throw_error(env, nullptr, "key(character) requires an owned native key window");
    return nullptr;
  }
  for (NSEventType type : {NSEventTypeKeyDown, NSEventTypeKeyUp}) {
    NSEvent* event = [NSEvent keyEventWithType:type location:NSZeroPoint modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
        context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:11];
    [NSApp sendEvent:event];
  }
  result = Describe(env, window);
  return result;
}
static NSRunningApplication* originalApp = nil;
static NSPoint originalCursor;
static napi_value AppState(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
  Number(env, result, "pid", NSRunningApplication.currentApplication.processIdentifier);
  Number(env, result, "frontmostPid", NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  Number(env, result, "activationPolicy", NSApp.activationPolicy);
  SetBoolean(env, result, "active", NSApp.active);
  SetBoolean(env, result, "running", NSApp.running);
  SetBoolean(env, result, "mainThread", NSThread.isMainThread);
  napi_set_named_property(env, result, "keyWindow", Describe(env, NSApp.keyWindow));
  return result;
}
static napi_value Preserve(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value previous;
  napi_get_cb_info(env, info, &count, &previous, nullptr, nullptr);
  if (count == 1) {
    napi_value pidValue, xValue, yValue;
    int32_t pid = 0;
    double x = 0, y = 0;
    if (napi_get_named_property(env, previous, "frontmostPid", &pidValue) != napi_ok ||
        napi_get_named_property(env, previous, "cursorX", &xValue) != napi_ok ||
        napi_get_named_property(env, previous, "cursorY", &yValue) != napi_ok ||
        napi_get_value_int32(env, pidValue, &pid) != napi_ok || pid <= 0 ||
        !Coordinates(env, xValue, yValue, &x, &y)) {
      napi_throw_type_error(env, nullptr, "preserve(previous native focus and cursor)");
      return nullptr;
    }
    originalApp = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    originalCursor = NSMakePoint(x, DesktopTop() - y);
  } else {
    originalApp = NSWorkspace.sharedWorkspace.frontmostApplication;
    originalCursor = NSEvent.mouseLocation;
  }
  napi_value result;
  napi_create_object(env, &result);
  Number(env, result, "frontmostPid", originalApp ? originalApp.processIdentifier : 0);
  Number(env, result, "cursorX", originalCursor.x);
  Number(env, result, "cursorY", DesktopTop() - originalCursor.y);
  napi_set_named_property(env, result, "keyWindow", Describe(env, NSApp.keyWindow));
  return result;
}
static napi_value Restore(napi_env env, napi_callback_info) {
  heldWindow = nil;
  napi_value result;
  napi_create_object(env, &result);
  const CGError error = CGWarpMouseCursorPosition(CGPointMake(originalCursor.x, DesktopTop() - originalCursor.y));
  SetBoolean(env, result, "cursorRestored", error == kCGErrorSuccess);
  const bool activated = !originalApp || originalApp.terminated ||
      [originalApp activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  SetBoolean(env, result, "frontmostRestoreRequested", activated);
  return result;
}
static napi_value Snapshot(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], result;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2) { napi_throw_type_error(env, nullptr, "snapshot(title, path)"); return nullptr; }
  NSWindow* window = Window(env, args[0]);
  NSString* file = Text(env, args[1]);
  if (!window || !file) return nullptr;
  NSView* view = Renderer(window.contentView);
  NSBitmapImageRep* bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
  [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
  if (!bitmap || ![[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:file atomically:YES]) {
    napi_throw_error(env, nullptr, "Cannot save owned AppKit renderer PNG");
    return nullptr;
  }
  napi_create_object(env, &result);
  Number(env, result, "pixelWidth", bitmap.pixelsWide);
  Number(env, result, "pixelHeight", bitmap.pixelsHigh);
  return result;
}
NAPI_MODULE_INIT() {
  const napi_property_descriptor methods[] = {
      {"appState", nullptr, AppState, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"geometry", nullptr, Geometry, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"hit", nullptr, Hit, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"warp", nullptr, Warp, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"mouse", nullptr, Mouse, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"key", nullptr, Key, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"preserve", nullptr, Preserve, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"restore", nullptr, Restore, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"snapshot", nullptr, Snapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
