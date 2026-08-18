import sys
import os
import json
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
import threading
import time

model = None
model_status = "loading"
model_error = None
device_used = "cpu"
compute_used = "int8"
init_time_ms = 0
lock = threading.Lock()
args_secret = ""

model_name_global = "tiny.en"
device_global = "auto"
compute_type_global = "default"
cache_dir_global = ""

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    pass

class TranscriptionHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Suppress logging to stderr

    def check_auth(self):
        auth_header = self.headers.get("X-Whisper-Secret")
        if not auth_header or auth_header != args_secret:
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Forbidden: Stale or missing request token."}).encode())
            return False
        return True

    def do_GET(self):
        if not self.check_auth():
            return

        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": model_status,
                "error": model_error,
                "device": device_used,
                "compute": compute_used,
                "initialization_time_ms": init_time_ms
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if not self.check_auth():
            return

        if self.path == "/transcribe":
            if model_status != "ready":
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"Model is not ready. Status: {model_status}"}).encode())
                return

            content_length = int(self.headers.get('Content-Length', 0))
            if content_length == 0:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Audio buffer cannot be empty."}).encode())
                return

            audio_bytes = self.rfile.read(content_length)

            import tempfile
            content_type = self.headers.get('Content-Type', '').lower()
            suffix = ".wav"
            if "webm" in content_type:
                suffix = ".webm"
            elif "mp3" in content_type:
                suffix = ".mp3"
            elif "ogg" in content_type:
                suffix = ".ogg"
            elif "wav" in content_type:
                suffix = ".wav"
            elif "m4a" in content_type:
                suffix = ".m4a"
            elif "aac" in content_type:
                suffix = ".aac"

            temp_file_fd, temp_file_path = tempfile.mkstemp(suffix=suffix)
            try:
                os.write(temp_file_fd, audio_bytes)
                os.close(temp_file_fd)

                start_time = time.time()
                
                # Try to acquire lock within 10 seconds to avoid blocking indefinitely
                acquired = lock.acquire(timeout=10.0)
                if not acquired:
                    self.send_response(503)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Transcription engine is busy. Please try again."}).encode())
                    return

                try:
                    try:
                        segments, info = model.transcribe(temp_file_path, beam_size=5)
                        text_list = [segment.text for segment in segments]
                    except Exception as transcribe_err:
                        global model, device_used, compute_used
                        if device_used == "cuda":
                            print("GPU transcription failed. Falling back to CPU.", file=sys.stderr)
                            from faster_whisper import WhisperModel
                            c_type = "int8"
                            model = WhisperModel(
                                model_name_global,
                                device="cpu",
                                compute_type=c_type,
                                download_root=cache_dir_global
                            )
                            device_used = "cpu"
                            compute_used = c_type
                            # Retry transcription on CPU
                            segments, info = model.transcribe(temp_file_path, beam_size=5)
                            text_list = [segment.text for segment in segments]
                        else:
                            raise transcribe_err

                    if info.duration > 60:
                        raise Exception("Audio duration exceeds the maximum limit of 60 seconds.")
                finally:
                    lock.release()

                duration_ms = int((time.time() - start_time) * 1000)
                full_text = "".join(text_list).strip()

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "text": full_text,
                    "language": info.language,
                    "language_probability": info.language_probability,
                    "duration": info.duration,
                    "latency_ms": duration_ms,
                    "device": device_used,
                    "compute": compute_used
                }).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            finally:
                if os.path.exists(temp_file_path):
                    try:
                        os.unlink(temp_file_path)
                    except Exception:
                        pass
        else:
            self.send_response(404)
            self.end_headers()

def load_model_thread(model_name, device, compute_type, cache_dir):
    global model, model_status, model_error, device_used, compute_used, init_time_ms
    start_load = time.time()
    try:
        from faster_whisper import WhisperModel
        
        device_to_try = device
        compute_to_try = compute_type
        
        # GPU -> CPU fallback logic
        if device_to_try == "auto":
            try:
                c_type = "float16" if compute_to_try == "default" else compute_to_try
                temp_model = WhisperModel(
                    model_name,
                    device="cuda",
                    compute_type=c_type,
                    download_root=cache_dir
                )
                # Dry run check to force dynamic loading of cuBLAS/CUDA libraries
                import numpy as np
                dummy = np.zeros(16000, dtype=np.float32)
                list(temp_model.transcribe(dummy)[0])

                model = temp_model
                device_used = "cuda"
                compute_used = c_type
            except Exception:
                # GPU initialization or library loading failed, fallback to CPU
                c_type = "int8" if compute_to_try == "default" else compute_to_try
                model = WhisperModel(
                    model_name,
                    device="cpu",
                    compute_type=c_type,
                    download_root=cache_dir
                )
                device_used = "cpu"
                compute_used = c_type
        else:
            if compute_to_try == "default":
                c_type = "float16" if device_to_try == "cuda" else "int8"
            else:
                c_type = compute_to_try
            model = WhisperModel(
                model_name,
                device=device_to_try,
                compute_type=c_type,
                download_root=cache_dir
            )
            device_used = device_to_try
            compute_used = c_type

        init_time_ms = int((time.time() - start_load) * 1000)
        model_status = "ready"
    except Exception as e:
        model_status = "error"
        model_error = str(e)

def main():
    global args_secret, model_name_global, device_global, compute_type_global, cache_dir_global
    parser = argparse.ArgumentParser(description="Local Whisper Transcription Server")
    parser.add_argument("--port", type=int, default=50051, help="Port to listen on")
    parser.add_argument("--model", default="tiny.en", help="Whisper model name")
    parser.add_argument("--device", default="auto", help="Execution device (cpu, cuda, auto)")
    parser.add_argument("--compute_type", default="default", help="Compute type")
    parser.add_argument("--secret", default="", help="Request authorization token")
    args = parser.parse_args()

    args_secret = args.secret
    model_name_global = args.model
    device_global = args.device
    compute_type_global = args.compute_type
    cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../.whisper_cache")
    cache_dir_global = cache_dir
    os.makedirs(cache_dir, exist_ok=True)

    # Start model loading in a background thread
    t = threading.Thread(
        target=load_model_thread,
        args=(args.model, args.device, args.compute_type, cache_dir)
    )
    t.daemon = True
    t.start()

    server = ThreadingHTTPServer(('127.0.0.1', args.port), TranscriptionHandler)
    server.serve_forever()

if __name__ == "__main__":
    main()
