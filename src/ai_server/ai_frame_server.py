from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
import tempfile
import cv2
import numpy as np
import os
import datetime
import shutil
import json

# Optional YOLO import
try:
    from ultralytics import YOLO
except ImportError:
    YOLO = None

app = FastAPI()

# Allow Photoshop Plugin / localhost CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load YOLO model (if available)
model = None
if YOLO is not None:
    try:
        model_path = "src/ai_server/runs/detect/train6/weights/best.pt"
        if os.path.exists(model_path):
            print(f"✅ Loaded YOLO model: {model_path}")
            model = YOLO(model_path)
        else:
            print(f"⚠️ YOLO model not found at {model_path}, using OpenCV fallback.")
    except Exception as e:
        print(f"⚠️ Failed to load YOLO model: {e}")
else:
    print("⚠️ YOLO not installed — using OpenCV only.")


# -------------------------------------------------
# 🧠 DETECT FRAMES
# -------------------------------------------------
@app.post("/detect_frames")
async def detect_frames(file: UploadFile = File(...)):
    """Detect frame regions in PSD preview image."""
    contents = await file.read()

    # Save temp image
    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
        tmp.write(contents)
        tmp_path = tmp.name

    img = cv2.imread(tmp_path)
    if img is None:
        print("⚠️ Could not read uploaded image.")
        return {"boxes": [], "image_size": {"width": 0, "height": 0}}

    boxes = []

    # 1️⃣ Try YOLO if available
    if model is not None:
        try:
            results = model.predict(source=tmp_path, conf=0.25, verbose=False)
            for r in results:
                for box in r.boxes.xyxy:
                    x1, y1, x2, y2 = box.tolist()
                    boxes.append({
                        "x": int(x1),
                        "y": int(y1),
                        "w": int(x2 - x1),
                        "h": int(y2 - y1)
                    })
            if boxes:
                print(f"✅ YOLO detected {len(boxes)} frames")
        except Exception as e:
            print(f"⚠️ YOLO detection failed: {e}")

    # 2️⃣ OpenCV fallback
    if not boxes:
        print("🧩 Using OpenCV fallback detection...")
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blur, 50, 150)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            if 100 < w < img.shape[1] and 100 < h < img.shape[0]:
                boxes.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h)})

        print(f"🧠 OpenCV detected {len(boxes)} possible frames")

    # 3️⃣ Return boxes + image size
    h, w, _ = img.shape
    print(f"📏 Image size: {w}x{h}")
    try:
        os.remove(tmp_path)
    except Exception:
        pass

    return {"boxes": boxes, "image_size": {"width": int(w), "height": int(h)}}


# -------------------------------------------------
# 🧠 FIT PHOTO INSIDE FRAME
# -------------------------------------------------
@app.post("/fit_photo")
async def fit_photo(frame_box: str = Form(...), photo: UploadFile = File(...)):
    """Calculate photo placement coordinates inside detected frame."""
    try:
        frame_data = json.loads(frame_box or "{}")

        # Defensive parsing — avoid NoneType errors
        x = int(frame_data.get("x") or 0)
        y = int(frame_data.get("y") or 0)
        w = int(frame_data.get("w") or 500)
        h = int(frame_data.get("h") or 500)

        # Save uploaded photo temp
        temp_dir = tempfile.mkdtemp()
        photo_path = os.path.join(temp_dir, photo.filename)
        with open(photo_path, "wb") as f:
            f.write(await photo.read())

        img = cv2.imread(photo_path)
        if img is None:
            raise ValueError("Failed to read uploaded photo.")

        # Optional: detect main content area
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 30, 100)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        if contours:
            largest = max(contours, key=cv2.contourArea)
            px, py, pw, ph = cv2.boundingRect(largest)
            photo_aspect = pw / ph if ph != 0 else 1
            frame_aspect = w / h if h != 0 else 1

            if photo_aspect > frame_aspect:
                new_w = w
                new_h = int(w / photo_aspect)
            else:
                new_h = h
                new_w = int(h * photo_aspect)

            left = x + (w - new_w) // 2
            top = y + (h - new_h) // 2
            right = left + new_w
            bottom = top + new_h
        else:
            left, top, right, bottom = x, y, x + w, y + h

        # Clean up
        try:
            os.remove(photo_path)
            os.rmdir(temp_dir)
        except Exception:
            pass

        print(f"✅ fit_photo → left:{left}, top:{top}, right:{right}, bottom:{bottom}")
        return {
            "target_box": {"left": left, "top": top, "right": right, "bottom": bottom},
            "rotation": 0
        }

    except Exception as e:
        print("❌ fit_photo error:", e)
        return {"error": str(e)}
