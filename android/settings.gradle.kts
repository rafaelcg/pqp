pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()

        // `io.livekit:livekit-android` depends on `com.github.davidliu:audioswitch`
        // at a commit hash, and that artifact is published nowhere but JitPack.
        // Without this the build does not fail at compile time. It fails while
        // *resolving* `debugRuntimeClasspath`, which reads like a network blip
        // rather than a missing repository.
        //
        // Scoped to that one group on purpose. JitPack builds artifacts on
        // demand out of arbitrary GitHub repos, so an unscoped entry would let
        // any future typo'd coordinate resolve against it.
        maven {
            url = uri("https://jitpack.io")
            content { includeGroup("com.github.davidliu") }
        }
    }
}

rootProject.name = "pqp"
include(":app")
