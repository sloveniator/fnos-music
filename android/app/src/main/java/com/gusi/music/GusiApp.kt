package com.gusi.music

import android.app.Application
import androidx.appcompat.app.AppCompatDelegate

/**
 * 进程级设置。
 *
 * **本应用恒为深色**（Web 端只有深色一套主题，壳的三屏——连接中/连不上/首次配置——必须与它同色），
 * 所以这里把 AppCompat 的夜间模式钉死在「深色」，理由有两个：
 *
 *  1. 系统切浅色时，壳与 WebView **不能跟着变浅** —— 页面是深色，变浅只会得到一堆
 *     浅色系统控件（复选框/滑杆/输入法候选条）压在深色底上；
 *  2. WebView 的 `prefers-color-scheme` 跟的是配置里的夜间位，不是应用主题。
 *     钉住之后 Web 端将来若加浅色主题，也不会因为「系统浅色」而和壳的观感打架。
 *
 * 为什么放在 Application 而不是 MainActivity.onCreate：`setDefaultNightMode` 在一个
 * **非夜间**配置的设备上需要一次配置变更才能生效，而 AppCompat 在 Activity 里调用它会走
 * `recreate()` —— 手机是浅色模式时，App 每次冷启动都白重建一次 Activity（有一帧闪白）。
 * 放在进程启动处则是在任何 Activity 创建之前就位，等价于「这台设备本来就是深色」。
 */
class GusiApp : Application() {

    override fun onCreate() {
        super.onCreate()
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES)
    }
}
