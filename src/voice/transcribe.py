import sys
import os
import json
import argparse

def main():
    parser = argparse.ArgumentParser(description="Local Whisper Transcription")
    parser.add_argument("--audio", required=True, help="Path to the audio file")
    parser.add_argument("--model", default="tiny.en", help="Whisper model name")
    parser.add_argument("--device", default="auto", help="Execution device (cpu, cuda, auto)")
    parser.add_argument("--compute_type", default="default", help="Compute type")
    args = parser.parse_args()

    if not os.path.exists(args.audio):
      print(json.dumps({"error": f"Audio file not found."}))
      sys.exit(1)

    try:
      from faster_whisper import WhisperModel
      
      # Determine model cache directory under the workspace
      cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../.whisper_cache")
      os.makedirs(cache_dir, exist_ok=True)
      
      device = args.device
      compute_type = args.compute_type
      device_used = "cpu"
      compute_used = "int8"
      model = None

      if device == "auto":
        try:
          c_type = "float16" if compute_type == "default" else compute_type
          model = WhisperModel(
            args.model,
            device="cuda",
            compute_type=c_type,
            download_root=cache_dir
          )
          device_used = "cuda"
          compute_used = c_type
        except Exception:
          c_type = "int8" if compute_type == "default" else compute_type
          model = WhisperModel(
            args.model,
            device="cpu",
            compute_type=c_type,
            download_root=cache_dir
          )
          device_used = "cpu"
          compute_used = c_type
      else:
        if compute_type == "default":
          c_type = "float16" if device == "cuda" else "int8"
        else:
          c_type = compute_type
        model = WhisperModel(
          args.model,
          device=device,
          compute_type=c_type,
          download_root=cache_dir
        )
        device_used = device
        compute_used = c_type
        
        segments, info = model.transcribe(args.audio, beam_size=5)
        
        text_list = []
        for segment in segments:
            text_list.append(segment.text)
            
        full_text = "".join(text_list).strip()
        
        print(json.dumps({
            "text": full_text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "device": device_used,
            "compute": compute_used
        }))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
