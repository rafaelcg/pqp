fn main() {
    // WebRTC's Objective-C SDK (inside the LiveKit SDK's prebuilt libwebrtc)
    // defines categories such as `+[NSString stringForStdString:]` in a static
    // library. Without -ObjC the linker drops them and the first peer
    // connection factory dies with "unrecognized selector" while listing H.264
    // encoders. The LiveKit Rust SDK documents the same flag for macOS and iOS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg-bins=-ObjC");
    }
}
