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

/**
 * The upload key, or nothing.
 *
 * Play refuses an APK or bundle signed with the debug key, and the key that
 * signs the *first* accepted upload is permanent for the life of the listing.
 * So it is a real keystore, and it is a file plus three secrets that must never
 * be in this repo: `pqp.keystoreFile`, `pqp.keystorePassword`, `pqp.keyAlias`
 * and `pqp.keyPassword`, read from `local.properties`, a `-P` flag or the
 * environment (`PQP_KEYSTOREFILE` and friends) like every other build input
 * here.
 *
 * When they are absent this is null, no release signing config is created, and
 * `assembleRelease` produces an **unsigned** APK. It used to fall back to the
 * debug key, which meant a release build looked like it had worked and was
 * rejected at the Play upload days later. See `docs/ANDROID_RELEASE.md`.
 */
val releaseKeystore: File? = config("pqp.keystoreFile", "")
    .takeIf { it.isNotBlank() }
    ?.let { path -> File(path).takeIf { it.isAbsolute } ?: rootProject.file(path) }

android {
    namespace = "gg.pqp.app"

    /**
     * 37, and not the 36 the plan asked for.
     *
     * 36 was tried and does not build: sixteen dependencies floor at 37,
     * including every `androidx.compose:*` in the 2026.08.00 BOM,
     * `androidx.core:core:1.19.0` and `okhttp-android:5.5.0`, each of which
     * fails the build with "requires libraries and applications that depend on
     * it to compile against version 37 or later". Lowering it means downgrading
     * all sixteen.
     *
     * The real worry behind that request was that the build only worked on a
     * laptop that happened to have the platform installed. That is fixed by
     * `.github/workflows/android.yml` installing `platforms;android-37`
     * explicitly, so a build failure is a repo fact rather than a local one.
     * `android.suppressUnsupportedCompileSdk` is gone with it: AGP 9.3.2 knows
     * API 37 perfectly well and emitted no warning to suppress, so the flag was
     * only ever hiding whatever it might have said next.
     */
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

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = config("pqp.keystorePassword", "")
                keyAlias = config("pqp.keyAlias", "pqp-upload")
                keyPassword = config("pqp.keyPassword", "")
            }
        }
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

            // The upload key when there is one, and **no signing config at
            // all** when there is not.
            //
            // It used to fall back to the debug key, which is worse than
            // failing: `assembleRelease` printed BUILD SUCCESSFUL, produced an
            // APK that installs fine, and the rejection arrived days later at
            // the Play upload. An unsigned release artifact is a problem you
            // find in the same minute you caused it. CI builds release this way
            // on purpose, to prove the shrinker and the ProGuard rules survive
            // without ever holding a key.
            signingConfig = signingConfigs.findByName("release")
        }
    }

    testOptions {
        unitTests {
            // The android.jar on the unit-test classpath is all stubs that
            // throw. Returning defaults instead keeps a single `Log.w` from
            // failing a test about something else entirely; nothing here
            // asserts on an Android framework call.
            isReturnDefaultValues = true
            all { test ->
                // A contract test's whole value is in its failure message. The
                // default one-line summary hides it.
                test.testLogging {
                    exceptionFormat =
                        org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
                    events("failed")
                }
            }
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

        // A lint **error** fails the lint task, which is what makes the CI
        // step mean something: `./gradlew :app:lint` that can never fail is a
        // green check with nothing behind it. This does not touch
        // `installDebug`, which runs no lint task at all; the only build it can
        // stop is a release, via `lintVitalRelease` below, and stopping a
        // release on a fatal issue is the point.
        //
        // Warnings stay warnings. The report is uploaded by
        // `.github/workflows/android.yml` either way.
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = true

        // Machine-readable, for the CI job to summarise. The HTML report is
        // still written next to it.
        xmlReport = true
        sarifReport = true
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
