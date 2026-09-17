import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 发布签名：android/keystore/keystore.properties 存在时才启用（该文件不入 git）
val keystorePropsFile = rootProject.file("keystore/keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
    namespace = "com.gusi.music"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.gusi.music"
        minSdk = 24
        targetSdk = 34
        versionCode = 30        // 与服务端/安装包版本同号，便于分辨手机装的是哪一版
        versionName = "1.0.30"
        resourceConfigurations += listOf("zh", "en")
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false          // WebView 壳没有反射逻辑，混淆收益低、排错成本高
            isShrinkResources = false
            if (keystoreProps.isNotEmpty()) signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "DebugProbesKt.bin")
    }

    lint {
        abortOnError = false                 // 先能出包；lint 报告单独看（见 android/README.md）
        checkReleaseBuilds = false
        // 声明了「车机媒体应用」之后，lint 会来提醒「你还没接车机语音搜索」。
        // 语音搜索（「播放某某」）是有意不做的功能（见 android/README.md 第 5、7 节），
        // 这里显式关掉这两条提醒，好让「lint 有 Error」永远等于「真出问题了」。
        disable += setOf("MissingIntentFilterForMediaSearch", "MissingOnPlayFromSearch")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // androidx.webkit：WebView 兼容层（暗色强制、渲染进程回收策略、版本查询）
    implementation("androidx.webkit:webkit:1.11.0")
    // androidx.media：MediaSessionCompat + MediaStyle 通知（锁屏/通知栏播放控制）
    implementation("androidx.media:media:1.7.0")

    testImplementation("junit:junit:4.13.2")
    // 单测跑在 JVM 上：android.jar 里的 org.json 只是桩（返回默认值），
    // 不额外给一份真实现的话，CarLibrary 的 JSON 解析在单测里会「静默解析出空曲库」。
    testImplementation("org.json:json:20240303")
}
