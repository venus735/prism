plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.prism.debug"
  compileSdk = 35
  ndkVersion = "29.0.13113456"

  defaultConfig {
    applicationId = "com.prism.debug"
    minSdk = 29
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
    externalNativeBuild {
      ndkBuild {
        abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }

  buildFeatures {
    viewBinding = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }

  externalNativeBuild {
    ndkBuild {
      path = file("../tun2socks/Android.mk")
    }
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.recyclerview:recyclerview:1.3.2")
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
