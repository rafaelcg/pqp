plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false

    // On the classpath, never applied here. `:app` applies it only when a
    // `google-services.json` is actually present, because the plugin fails the
    // build outright when it is not, and this repo does not ship one. See
    // docs/ANDROID.md.
    alias(libs.plugins.google.services) apply false
}
