#include <node_api.h>
#undef NAPI_MODULE_INIT
#define NAPI_MODULE_INIT() static napi_value SharedInputInit(napi_env env, napi_value exports)
#include "macos-native-pet-input-helper.mm"
#undef NAPI_MODULE_INIT

// Extend the shared read-only AppKit adapter; no DOM input or replacement view.
static NSWindow* OwnedKeyWindow(napi_env env) {
  NSWindow* window = NSApp.keyWindow;
  NSWindow* owner = window;
  while (owner.sheetParent) owner = owner.sheetParent;
  if (!window || !Renderer(owner.contentView)) {
    napi_throw_error(env, nullptr, "Native key recipient is not an owned renderer or its sheet");
    return nil;
  }
  return window;
}
static void SendKey(NSWindow* window, NSString* text, unsigned short code, NSEventModifierFlags flags) {
  for (NSEventType type : {NSEventTypeKeyDown, NSEventTypeKeyUp}) {
    NSEvent* event = [NSEvent keyEventWithType:type location:NSZeroPoint modifierFlags:flags
      timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
      characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code];
    [NSApp sendEvent:event];
  }
}
static napi_value KeyCode(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  uint32_t code = 0, flags = 0;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2 || napi_get_value_uint32(env, args[0], &code) != napi_ok ||
      napi_get_value_uint32(env, args[1], &flags) != napi_ok || code > 127 || flags > 15) {
    napi_throw_type_error(env, nullptr, "keyCode(code, modifiers): shift=1 command=2 option=4 control=8");
    return nullptr;
  }
  NSWindow* window = OwnedKeyWindow(env);
  if (!window) return nullptr;
  if (code == 36) {
    bool picker = false;
    for (NSWindow* parent = window; parent; parent = parent.sheetParent) {
      if ([parent isKindOfClass:NSOpenPanel.class]) { picker = true; break; }
    }
    if (!picker) {
      napi_throw_error(env, nullptr, "Native Return is restricted to the owned file picker, never the agent composer");
      return nullptr;
    }
  }
  NSEventModifierFlags modifiers = ((flags & 1) ? NSEventModifierFlagShift : 0) |
      ((flags & 2) ? NSEventModifierFlagCommand : 0) | ((flags & 4) ? NSEventModifierFlagOption : 0) |
      ((flags & 8) ? NSEventModifierFlagControl : 0);
  NSString* text = code == 36 ? @"\r" : code == 53 ? @"\x1b" : code == 5 ? @"g" : code == 0 ? @"a" : code == 17 ? @"t" : @"";
  SendKey(window, text, (unsigned short)code, modifiers);
  return Describe(env, window);
}
static napi_value TypeText(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value value;
  napi_get_cb_info(env, info, &count, &value, nullptr, nullptr);
  NSString* text = count == 1 ? Text(env, value) : nil;
  NSWindow* window = OwnedKeyWindow(env);
  if (!text || !window) return nullptr;
  if ([text rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound) {
    napi_throw_error(env, nullptr, "Native text must not contain submit/newline keys");
    return nullptr;
  }
  for (NSUInteger index = 0; index < text.length; ++index) SendKey(window, [text substringWithRange:NSMakeRange(index, 1)], 11, 0);
  return Describe(env, window);
}
static napi_value SheetState(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
  NSWindow* window = NSApp.keyWindow;
  String(env, result, "class", window ? NSStringFromClass(window.class) : @"");
  String(env, result, "firstResponder", window.firstResponder ? NSStringFromClass(window.firstResponder.class) : @"");
  SetBoolean(env, result, "sheet", window.sheetParent != nil);
  SetBoolean(env, result, "openPanel", [window isKindOfClass:NSOpenPanel.class]);
  SetBoolean(env, result, "active", NSApp.active);
  Number(env, result, "activationPolicy", NSApp.activationPolicy);
  Number(env, result, "modalWindowNumber", NSApp.modalWindow.windowNumber);
  napi_value panels;
  napi_create_array(env, &panels);
  uint32_t index = 0;
  for (NSWindow* panel in NSApp.windows) {
    if (![panel isKindOfClass:NSOpenPanel.class]) continue;
    napi_value detail;
    napi_create_object(env, &detail);
    Number(env, detail, "windowNumber", panel.windowNumber);
    String(env, detail, "title", panel.title);
    SetBoolean(env, detail, "visible", panel.visible);
    SetBoolean(env, detail, "isKey", panel.isKeyWindow);
    SetBoolean(env, detail, "isModal", NSApp.modalWindow == panel);
    Number(env, detail, "sheetParentNumber", panel.sheetParent.windowNumber);
    String(env, detail, "sheetParentTitle", panel.sheetParent.title);
    SetBoolean(env, detail, "opaque", panel.opaque);
    Number(env, detail, "alpha", panel.alphaValue);
    Number(env, detail, "backgroundAlpha", [panel.backgroundColor colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace].alphaComponent);
    napi_set_element(env, panels, index++, detail);
  }
  napi_set_named_property(env, result, "panels", panels);
  return result;
}
static napi_value PanelView(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value value;
  napi_get_cb_info(env, info, &count, &value, nullptr, nullptr);
  NSString* file = count == 1 ? Text(env, value) : nil;
  NSWindow* window = OwnedKeyWindow(env);
  if (!file || !window) return nullptr;
  if (![window isKindOfClass:NSOpenPanel.class] || !window.visible || !window.sheetParent) {
    napi_throw_error(env, nullptr, "Only the visible owned native open sheet can be captured"); return nullptr;
  }
  NSView* view = window.contentView;
  NSBitmapImageRep* bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
  [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
  if (!bitmap || ![[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:file atomically:YES]) {
    napi_throw_error(env, nullptr, "Cannot save actual owned native open-panel view"); return nullptr;
  }
  napi_value result; napi_create_object(env, &result);
  Number(env, result, "windowNumber", window.windowNumber);
  String(env, result, "title", window.title);
  String(env, result, "firstResponder", window.firstResponder ? NSStringFromClass(window.firstResponder.class) : @"");
  Number(env, result, "width", view.bounds.size.width);
  Number(env, result, "height", view.bounds.size.height);
  Number(env, result, "pixelsWide", bitmap.pixelsWide);
  Number(env, result, "pixelsHigh", bitmap.pixelsHigh);
  String(env, result, "captureMethod", @"Owned contentView cacheDisplay; does not establish remote-view pixel contents");
  return result;
}
extern "C" __attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  SharedInputInit(env, exports);
  const napi_property_descriptor methods[] = {
    {"keyCode", nullptr, KeyCode, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"text", nullptr, TypeText, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sheetState", nullptr, SheetState, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"panelView", nullptr, PanelView, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
