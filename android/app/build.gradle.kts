import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.BuiltArtifactsLoader
import java.util.Properties
import java.util.zip.ZipFile

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

/**
 * Whether this build can talk to Firebase Cloud Messaging at all.
 *
 * `google-services.json` is a per-project file that nobody has created yet, and
 * it is gitignored besides, so the normal state of this repo is "absent". Two
 * things follow, and both are deliberate:
 *
 *  1. The `com.google.gms.google-services` plugin is applied ONLY when the file
 *     exists. Applied without it the plugin does not warn, it fails the build,
 *     which would mean nobody could compile the app until somebody created a
 *     Firebase project.
 *  2. The result is a BuildConfig flag rather than a comment, because the
 *     Kotlin side has to make the same decision at runtime: with no Firebase
 *     project there is no token to register and no message to receive, so the
 *     push surface stays off and says so, the way the web client gates its
 *     analytics behind an unset env var.
 *
 * `firebase-messaging` itself is a dependency either way. It compiles and links
 * with no config; only its runtime initialisation needs one, and every call
 * into it is behind the flag.
 */
val googleServicesConfig = file("google-services.json")
val pushAvailable = googleServicesConfig.exists()

if (pushAvailable) {
    apply(plugin = "com.google.gms.google-services")
}

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

        // Read by gg.pqp.app.push.Push. See the note on `pushAvailable` above.
        buildConfigField("boolean", "PUSH_AVAILABLE", pushAvailable.toString())
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

            // Native crash reports, in names rather than in addresses.
            //
            // Play warns on every bundle that carries native code with no
            // symbol file, and the warning is not cosmetic: without one, a
            // crash inside libwebrtc arrives as a column of raw addresses, and
            // the one part of this app most likely to crash on a device nobody
            // here owns is the one part written in C++.
            //
            // SYMBOL_TABLE rather than FULL, and that is the honest ceiling
            // here rather than a preference. The WebRTC artifact
            // (`io.github.webrtc-sdk:android`) ships **already stripped**: its
            // `libjingle_peerconnection_so.so` carries `.dynsym` and nothing
            // else, no `.symtab` and no `.debug_*` sections at all. FULL would
            // ask for DWARF that is not in the file. What SYMBOL_TABLE can
            // still hand Play is the exported symbols, which resolves a frame
            // to the nearest exported function instead of to a hex address.
            //
            // AGP writes the result into the bundle itself, under
            // `BUNDLE-METADATA/com.android.tools.build.debugsymbols/`, so Play
            // reads it off the upload and there is no separate file to send.
            // It applies to `bundleRelease` only; `assembleRelease` (what CI
            // runs) produces an APK and is unaffected.
            ndk {
                debugSymbolLevel = "SYMBOL_TABLE"
            }
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
        // A lint warning must never be why a debug build cannot be installed;
        // a release is held to the stricter bar.
        abortOnError = false
        checkReleaseBuilds = true
    }
}

/**
 * Proves that the classes libwebrtc looks up **from native code** are still in
 * the shrunk artifact.
 *
 * This exists because of a crash that reached the Play internal testing track:
 * R8 removed `org.jni_zero.JniInit`, nothing in Kotlin names it, and
 * `JNI_OnLoad` inside `libjingle_peerconnection_so.so` aborts the process when
 * `FindClass` cannot find it. Tapping a voice channel killed the app on every
 * device. Debug builds are not minified, so it was invisible on every emulator
 * this project has ever used, and CI's release build proved only that the
 * artifact *compiles*, which it did, perfectly.
 *
 * A keep rule alone would not catch it a second time, because the failure mode
 * is a rule that is **missing**, not one that is wrong. So this checks the
 * artifact rather than the configuration. The dex format stores every class as
 * a plain descriptor string, so the presence of `Lorg/jni_zero/JniInit;` in the
 * bytes is a direct answer to "did the class survive", with no dex parser to
 * keep in step with a format.
 *
 * It cannot check every class the JNI layer resolves and does not pretend to.
 * It checks one from each package the WebRTC artifact ships, which is the level
 * at which the keep rules are written and therefore the level at which one goes
 * missing.
 */
abstract class VerifyNativeJniClassesTask : DefaultTask() {

    /** The `.apk` or `.aab` files to look inside. */
    @get:InputFiles
    abstract val archives: ConfigurableFileCollection

    /** Descriptors, as they appear in a dex file's string table. */
    @get:Input
    abstract val required: ListProperty<String>

    @TaskAction
    fun verify() {
        val targets = archives.files.filter {
            it.isFile && (it.name.endsWith(".apk") || it.name.endsWith(".aab"))
        }
        check(targets.isNotEmpty()) { "No .apk or .aab to verify" }

        for (archive in targets) {
            // An AAB keeps its dex at `base/dex/classes.dex`, an APK at the
            // root, so the entries are matched by extension rather than by
            // path.
            val dex = ZipFile(archive).use { zip ->
                zip.entries()
                    .toList()
                    .filter { it.name.endsWith(".dex") }
                    .map { entry ->
                        zip.getInputStream(entry).use { String(it.readBytes(), Charsets.ISO_8859_1) }
                    }
            }
            check(dex.isNotEmpty()) { "No dex inside ${archive.name}" }

            val missing = required.get().filter { descriptor ->
                dex.none { it.contains(descriptor) }
            }
            check(missing.isEmpty()) {
                buildString {
                    appendLine("${archive.name} is missing classes libwebrtc loads by name:")
                    missing.forEach { appendLine("  $it") }
                    appendLine()
                    appendLine("R8 removed them because nothing in Kotlin references them.")
                    appendLine("`JNI_OnLoad` aborts the process when FindClass fails, so this")
                    appendLine("artifact would crash with SIGTRAP the moment somebody joins a")
                    appendLine("voice channel. Add a -keep rule in app/proguard-rules.pro.")
                }
            }
            logger.lifecycle("${archive.name}: all ${required.get().size} native JNI classes present")
        }
    }
}

/**
 * One from each package `io.github.webrtc-sdk:android` ships. `JniInit` is the
 * one that was actually missing.
 */
val nativeJniClasses = listOf(
    "Lorg/jni_zero/JniInit;",
    "Lorg/webrtc/PeerConnectionFactory;",
    "Lorg/webrtc/audio/JavaAudioDeviceModule;",
)

androidComponents {
    // Release only: the debug variant is not minified, so there is nothing that
    // could go missing and nothing to verify.
    onVariants(selector().withBuildType("release")) { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }

        val verifyApk = tasks.register<VerifyNativeJniClassesTask>("verify${name}NativeJniClasses") {
            group = "verification"
            description = "Fails when R8 has removed a class libwebrtc resolves from native code."
            archives.from(variant.artifacts.get(SingleArtifact.APK).map { it.asFileTree })
            required.set(nativeJniClasses)
        }

        // The bundle is checked separately rather than being trusted to the
        // APK's result. It is the artifact that goes to Play, it is the one
        // that crashed, and a human uploading one may never build the other.
        val verifyBundle =
            tasks.register<VerifyNativeJniClassesTask>("verify${name}BundleNativeJniClasses") {
                group = "verification"
                description = "The same check, against the .aab that is uploaded."
                archives.from(variant.artifacts.get(SingleArtifact.BUNDLE))
                required.set(nativeJniClasses)
            }

        // `matching {}.configureEach {}` rather than `named()`: neither task
        // exists yet while variants are being configured, and `named` on a task
        // that is not there yet fails the configuration outright.
        tasks.matching { it.name == "assemble$name" }.configureEach { dependsOn(verifyApk) }
        tasks.matching { it.name == "bundle$name" }.configureEach { dependsOn(verifyBundle) }
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
    // material-icons-extended is deliberately absent. Every icon in the app now
    // comes from `ui/theme/PqpIcons.kt`, which is checked-in Lucide path data
    // and no dependency at all, so the artifact was buying nothing but a very
    // large set of glyphs the design language does not use. See
    // docs/ANDROID_DESIGN.md, section Iconography.

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    // Without this artifact Coil has no animated decoder at all, so it reads a
    // GIF's first frame and stops. See the components block in PqpApplication.
    implementation(libs.coil.gif)

    // The only thing in the module that can play a video. There is no
    // VideoView and no MediaPlayer here either; see ui/media/VideoPlayer.kt.
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)

    implementation(libs.clerk.ui)
    implementation(libs.webrtc)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
