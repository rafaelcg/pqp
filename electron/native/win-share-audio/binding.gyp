{
  "targets": [
    {
      "target_name": "pqp_share_audio",
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": [
              "src/addon.cc",
              "src/loopback_capture.cc",
              "src/process_info.cc"
            ],
            "defines": [
              "NAPI_VERSION=8",
              "UNICODE",
              "_UNICODE",
              "WIN32_LEAN_AND_MEAN",
              "NOMINMAX"
            ],
            "libraries": ["ole32.lib", "user32.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/std:c++17", "/W4", "/WX"]
              }
            }
          }
        ]
      ]
    }
  ]
}
