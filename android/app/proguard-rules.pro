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

# OkHttp names optional platform integrations it does not ship.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
