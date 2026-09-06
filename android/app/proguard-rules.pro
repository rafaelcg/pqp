# kotlinx.serialization keeps each @Serializable class's serializer on its
# companion. R8 cannot see that they are used, so without these rules a
# minified build parses nothing and every screen comes up empty.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class gg.pqp.app.** {
    *** Companion;
}
-keepclasseswithmembers class gg.pqp.app.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# WebRTC calls back into its own classes from native code, where R8 cannot
# follow the reference.
-keep class org.webrtc.** { *; }

# And into jni_zero's, which is the half that was missing and which crashed
# every minified build the instant somebody joined a voice channel.
#
# `io.github.webrtc-sdk:android` is generated with jni_zero, Chromium's JNI
# generator, and ships FOUR packages: org.webrtc, org.webrtc.audio,
# org.jni_zero and org.jni_zero.internal. `JNI_OnLoad` in
# libjingle_peerconnection_so.so does `FindClass("org/jni_zero/JniInit")` and
# aborts the process when it is not there. Nothing in Kotlin ever names that
# class, so R8 removed it, and `System.loadLibrary` then took the whole app
# down with SIGTRAP:
#
#   W jni_zero: jni_zero.cc:38 Failed to find class org/jni_zero/JniInit
#   F libc   : Fatal signal 5 (SIGTRAP), code 1 (TRAP_BRKPT)
#
# The call site is `PeerConnectionFactory.initialize` in `VoiceEngine.start`,
# which runs on the `welcome` frame, so the crash was "tap a voice channel" on
# every device, alone or not. Debug builds were fine because they are not
# minified, and CI's release build only ever proved the artifact *compiles*.
# `verifyReleaseNativeJniClasses` in build.gradle.kts is what now proves the
# class survives into the APK.
-keep class org.jni_zero.** { *; }

# OkHttp names optional platform integrations it does not ship.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# LiveKit ships a SECOND libwebrtc, prefixed, with the same JNI_OnLoad in it.
#
# `io.livekit:livekit-android` pulls `io.github.webrtc-sdk:android-prefixed`,
# the same generated code relocated under `livekit.org.*` and packaged as
# `liblkjingle_peerconnection_so.so`. It coexists with the app's own
# `org.webrtc` build by design (two artifacts, two namespaces, two native
# libraries), so every rule above covers none of it, and
# `strings liblkjingle_peerconnection_so.so` contains
# `livekit/org/jni_zero/JniInit` exactly as its unprefixed twin does.
#
# Unlike `io.github.webrtc-sdk:android`, which ships no consumer rules at all
# (which is why the crash happened), the LiveKit AAR carries a `proguard.txt`
# that keeps `livekit.org.webrtc.**` members with native methods and everything
# annotated `@livekit.**.CalledByNative`. That is enough today: a minified build
# with the two lines below commented out still contains `JniInit`, which was
# checked rather than assumed.
#
# They stay anyway, because "today" is doing a lot of work in that sentence. A
# library's consumer rules are the library's to narrow on any version bump, and
# the failure mode when they do is not a build error. It is SIGTRAP on the
# first voice channel, on release builds only. The rules are the cheap half; the
# half that actually proves it is `nativeJniClasses` in build.gradle.kts, which
# now greps the built APK and AAB for one class per prefixed package.
-keep class livekit.org.webrtc.** { *; }
-keep class livekit.org.jni_zero.** { *; }
