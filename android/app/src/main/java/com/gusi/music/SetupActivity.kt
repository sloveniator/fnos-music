package com.gusi.music

import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.net.HttpURLConnection
import java.net.URL

/**
 * 首次启动 / 更换服务器：填地址 → 测通 → 保存。
 *
 * 这里只做「能不能连上」的判断（GET / 拿到 2xx/3xx 就算通），不做登录 ——
 * 登录永远是 Web 端自己的事，壳里没有第二套账号逻辑。
 */
class SetupActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var input: EditText
    private lateinit var result: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        prefs = Prefs(this)
        input = findViewById(R.id.input_url)
        result = findViewById(R.id.test_result)

        if (prefs.configured) {
            input.setText(prefs.baseUrl)
            input.setSelection(input.text.length)
        }

        findViewById<Button>(R.id.btn_test).setOnClickListener { testConnection() }
        findViewById<Button>(R.id.btn_save).setOnClickListener { save() }
    }

    private fun normalized(): String? = ServerAddress.normalize(input.text.toString())

    private fun testConnection() {
        val base = normalized() ?: run {
            showResult(getString(R.string.setup_invalid), ok = false)
            return
        }
        showResult(getString(R.string.setup_testing), ok = null)
        Thread {
            val r = probe(base)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                showResult(r.msg, ok = r.ok)
            }
        }.start()
    }

    private class ProbeResult(val ok: Boolean, val msg: String)

    private fun probe(base: String): ProbeResult {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$base/").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 6000
                readTimeout = 8000
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "GusiMusicApp/${BuildConfig.VERSION_NAME}")
            }
            val code = conn.responseCode
            if (code in 200..399) {
                ProbeResult(true, getString(R.string.setup_test_ok, code))
            } else {
                ProbeResult(false, getString(R.string.setup_test_fail, "HTTP $code"))
            }
        } catch (t: Throwable) {
            Log.i(TAG, "探测失败：$base", t)
            ProbeResult(false, getString(R.string.setup_test_fail, t.message ?: t.javaClass.simpleName))
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Throwable) {
            }
        }
    }

    private fun save() {
        val base = normalized()
        if (base == null) {
            showResult(getString(R.string.setup_invalid), ok = false)
            return
        }
        prefs.baseUrl = base
        Toast.makeText(this, getString(R.string.setup_saved, base), Toast.LENGTH_SHORT).show()
        setResult(RESULT_OK)
        finish()
    }

    private fun showResult(text: String, ok: Boolean?) {
        result.visibility = View.VISIBLE
        result.text = text
        val color = when (ok) {
            true -> R.color.accent
            false -> R.color.danger
            null -> R.color.fg_dim
        }
        result.setTextColor(ContextCompat.getColor(this, color))
    }

    companion object {
        private const val TAG = "GusiSetup"
    }
}
