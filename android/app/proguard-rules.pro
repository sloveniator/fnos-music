# R8 规则（当前 release 关闭了压缩/混淆，见 app/build.gradle.kts 的 isMinifyEnabled = false）。
#
# 这份文件的真正用途是「以后想开混淆时别踩坑」：
# WebView 的 JS 桥靠 @JavascriptInterface 注解的方法名被网页端直接调用
# （window.GusiBridge.setState(...)）。一旦方法名被 R8 重命名，网页端调用会
# 静默失效 —— 不抛异常、不报错，只是通知栏再也不更新，极难排查。
# 所以哪怕现在不开混淆，也先把 keep 规则写死在这里。

-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 桥接类整体保留（类名+成员名），供 JS 侧按名字查找
-keep class com.gusi.music.JsBridge { *; }

# 序列化/反射无关：本壳没有 Gson/Jackson，不引混淆黑名单
