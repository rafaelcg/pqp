import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Build-time configuration, read from `local.properties`, a `-P` flag or the
 * environment. Nothing here is committed.
 *
 * A Clerk *publishable* key is public by design (the web client ships one in
 * its JS bundle) but it still differs per deployment, so it is a build input
 * rather than a literal in Kotlin. Same reasoning as `ios/project.yml`.
 */
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun config(name: String, fallback: String): String =
    (project.findProperty(name) as String?)
        ?: localProperties.getProperty(name)
        ?: System.getenv(name.replace('.', '_').uppercase())
        ?: fallback

android {
    namespace = "gg.pqp.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "gg.pqp.app"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    androidResources {
        // The two languages the product ships in. Anything else in a
        // dependency's resources is dropped from the APK rather than offered
        // as a half-translated surface.
        localeFilters += listOf("en", "pt-rBR")
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            // `localhost` on the device, reached through
            // `adb reverse tcp:3001 tcp:3001`. That works identically on an
            // emulator and on a phone plugged in over USB. The emulator's
            // 10.0.2.2 host alias is the documented alternative, and did not
            // route on the Pixel 10 Pro / API 37 image this was written
            // against, which is why the reverse tunnel is the default rather
            // than the fallback. See docs/ANDROID.md.
            buildConfigField("String", "API_URL", "\"${config("pqp.apiUrl", "http://localhost:3001")}\"")
            buildConfigField("String", "WS_URL", "\"${config("pqp.wsUrl", "ws://localhost:3001/ws")}\"")
            buildConfigField("String", "CLERK_PUBLISHABLE_KEY", "\"${config("pqp.clerkPublishableKey", "")}\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            buildConfigField("String", "API_URL", "\"${config("pqp.apiUrl", "https://api.pqp.gg")}\"")
            buildConfigField("String", "WS_URL", "\"${config("pqp.wsUrl", "wss://api.pqp.gg/ws")}\"")
            buildConfigField("String", "CLERK_PUBLISHABLE_KEY", "\"${config("pqp.clerkPublishableKey", "")}\"")

            // Debuggable signing so `assembleRelease` produces something
            // installable without a keystore nobody has yet. Replace before any
            // Play upload; see docs/ANDROID.md.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    lint {
        // `mipmap-anydpi-v26` is the qualifier Android's own launcher-icon
        // template uses, and dropping it (minSdk is already 26) makes AAPT2
        // stop resolving the folder at all: the build fails outright with
        // "resource mipmap/ic_launcher not found". The warning is wrong here.
        disable += "ObsoleteSdkInt"
        // A lint warning must never be why a debug build cannot be installed;
        // a release is held to the stricter bar.
        abortOnError = false
        checkReleaseBuilds = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    implementation(libs.clerk.ui)
    implementation(libs.webrtc)

    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
