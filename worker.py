import os
import time
import base64
import requests
import subprocess
import tempfile
import threading
from flask import Flask, request, jsonify
from flask_cors import CORS
from supabase import create_client, Client
from dotenv import load_dotenv

# ─── CONFIGURATION ───────────────────────────────────────────────────────────
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
MIDTRANS_SERVER_KEY = os.getenv("MIDTRANS_SERVER_KEY")
FONNTE_TOKEN = os.getenv("FONNTE_TOKEN")

if not all([SUPABASE_URL, SUPABASE_KEY, MIDTRANS_SERVER_KEY, FONNTE_TOKEN]):
    print("❌ ERROR: Missing environment variables! Check your .env file.")
    exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*", "allow_headers": ["Content-Type", "Bypass-Tunnel-Reminder"]}})

# ─── SHARED UTILS ────────────────────────────────────────────────────────────
def get_midtrans_auth():
    encoded = base64.b64encode(f"{MIDTRANS_SERVER_KEY}:".encode()).decode()
    return {"Authorization": f"Basic {encoded}", "Accept": "application/json"}

def analyze_pdf(path):
    """Menganalisis PDF untuk jumlah halaman dan cakupan tinta CMYK."""
    try:
        cmd = ["gs", "-q", "-o", "-", "-sDEVICE=inkcov", path]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if res.returncode != 0: return None
        lines = res.stdout.strip().split('\n')
        pages, c, m, y, k = 0, 0.0, 0.0, 0.0, 0.0
        for line in lines:
            parts = line.split()
            if len(parts) >= 4:
                pages += 1
                c += float(parts[0]); m += float(parts[1]); y += float(parts[2]); k += float(parts[3])
        if pages == 0: return None
        return {"pages": pages, "ink_c": c/pages, "ink_m": m/pages, "ink_y": y/pages, "ink_k": k/pages}
    except: return None

def send_whatsapp(target, order_id, status, items, packaging_name=None):
    """Mengirim notifikasi WhatsApp via Fonnte."""
    item_details = ""
    if items:
        item_details = "\nRincian File:\n"
        for item in items:
            # Skip items that are actually packaging (no md5_hash)
            if not item.get('md5_hash'):
                continue
            mode = "Warna" if item.get('print_mode') == 'color' else "BW"
            item_details += f"- {item.get('file_name')} ({item.get('pages', 0)} hal, {mode})\n"
    
    if packaging_name:
        item_details += f"Kemasan: {packaging_name}\n"

    messages = {
        "paid": f"Pembayaran Lunas! Dokumen ID {order_id[:8]} sudah masuk antrian cetak.{item_details}Silakan tunggu di depan kios.",
        "ready": f"Dokumen ID {order_id[:8]} sudah selesai dicetak.{item_details}Silakan datang ke lokasi kios kami dan tunjukkan pesan ini.",
        "picked_up": f"Terima kasih! Dokumen ID {order_id[:8]} telah diambil. Sampai jumpa kembali!"
    }
    
    msg = messages.get(status, f"Update Dokumen ID {order_id[:8]}: Status {status}{item_details}")
    
    try:
        requests.post(
            'https://api.fonnte.com/send',
            data={'target': target, 'message': msg},
            headers={'Authorization': FONNTE_TOKEN}
        )
        print(f"📩 WA Sent to {target} (Status: {status})")
    except Exception as e:
        print(f"❌ Failed to send WA: {e}")

# ─── API ROUTES (Flask) ──────────────────────────────────────────────────────
@app.route('/create-payment', methods=['POST'])
def create_payment():
    try:
        data = request.json
        job_id = data.get('jobId')
        amount = data.get('amount')
        contact = data.get('customer_contact')

        payload = {
            "transaction_details": {"order_id": job_id, "gross_amount": int(amount)},
            "item_details": [{"id": "item-01", "price": int(amount), "quantity": 1, "name": "Cetak Dokumen"}],
            "custom_field1": contact,
            "usage_limit": 1
        }
        
        response = requests.post(
            "https://app.sandbox.midtrans.com/snap/v1/transactions",
            json=payload, headers=get_midtrans_auth()
        )
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/analyze', methods=['POST'])
def analyze():
    if 'file' not in request.files: return jsonify({"error": "No file"}), 400
    file = request.files['file']
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        file.save(tmp.name)
        path = tmp.name
    try:
        res = analyze_pdf(path)
        if os.path.exists(path): os.remove(path)
        return jsonify({"status": "success", "metadata": res}) if res else (jsonify({"error": "GS fail"}), 500)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/send-wa', methods=['POST'])
def api_send_wa():
    data = request.json
    send_whatsapp(data.get('target'), data.get('orderId'), data.get('status'), data.get('items', []), data.get('packagingName'))
    return jsonify({"status": "success"})

# ─── BACKGROUND TASK 1: PAYMENT WATCHER ──────────────────────────────────────
def payment_watcher():
    print("🔍 [Watcher] Monitoring payments...")
    while True:
        try:
            # Cari job yang pending tapi sudah ada total harga
            res = supabase.table("print_jobs").select("*, print_job_items(*)").eq("status", "pending").gt("total_price", 0).execute()
            for job in res.data:
                res_midtrans = requests.get(f"https://api.sandbox.midtrans.com/v2/{job['id']}/status", headers=get_midtrans_auth())
                if res_midtrans.status_code == 200:
                    st = res_midtrans.json()
                    if st.get("transaction_status") in ["settlement", "capture", "success"]:
                        contact = st.get("custom_field1")
                        update_data = {"status": "paid"}
                        if contact: update_data["contact"] = contact
                        
                        supabase.table("print_jobs").update(update_data).eq("id", job['id']).execute()
                        
                        # WhatsApp notification
                        items = job.get('print_job_items', [])
                        pkg_item = next((i for i in items if not i.get('md5_hash')), None)
                        pkg_name = pkg_item.get('file_name') if pkg_item else None
                        
                        if contact:
                            send_whatsapp(contact, job['id'], "paid", items, pkg_name)
                        print(f"✅ [Watcher] Job {job['id'][:8]} PAID.")
        except Exception as e:
            print(f"⚠️ [Watcher] Error: {e}")
        time.sleep(10)

# ─── BACKGROUND TASK 2: PRICING PROCESSOR ────────────────────────────────────
def pricing_processor():
    print("🧮 [Processor] Calculating costs...")
    while True:
        try:
            jobs = supabase.table("print_jobs").select("*, print_job_items(*)").eq("status", "calculating").execute().data
            sett = supabase.table("settings").select("*").eq("id", 1).single().execute().data

            for job in jobs:
                grand_total = 0
                for item in job['print_job_items']:
                    # 1. Analisis PDF jika metadata hilang (pengamanan jika api /analyze gagal di client)
                    if not item.get('pages') and item.get('storage_name'):
                        path = f"tmp_{item['id']}.pdf"
                        with open(path, "wb") as f:
                            f.write(supabase.storage.from_("documents").download(item['storage_name']))
                        analysis = analyze_pdf(path)
                        if analysis:
                            item.update(analysis)
                        if os.path.exists(path): os.remove(path)

                    # 2. Hitung Harga
                    pages = item.get('pages', 1)
                    if pages == 0: # Ini kemungkinan produk fisik (kemasan)
                        price = item.get('price', 0)
                    else:
                        p_paper = pages * float(sett['paper_price'])
                        ink_c, ink_m, ink_y, ink_k = item.get('ink_c', 0), item.get('ink_m', 0), item.get('ink_y', 0), item.get('ink_k', 0)
                        
                        if item['print_mode'] == 'bw':
                            gray_k = ink_k + (0.299 * ink_c + 0.587 * ink_m + 0.114 * ink_y)
                            p_ink = gray_k * float(sett['black_ink_price'])
                        else:
                            p_ink = (ink_c + ink_m + ink_y) * float(sett['color_ink_price']) + ink_k * float(sett['black_ink_price'])
                        
                        price = round(p_paper + p_ink)
                    
                    grand_total += price
                    supabase.table("print_job_items").update({
                        "pages": pages, "price": price,
                        "ink_c": item.get('ink_c', 0), "ink_m": item.get('ink_m', 0), "ink_y": item.get('ink_y', 0), "ink_k": item.get('ink_k', 0)
                    }).eq("id", item['id']).execute()

                supabase.table("print_jobs").update({"total_price": grand_total, "status": "pending"}).eq("id", job['id']).execute()
                print(f"✅ [Processor] Job {job['id'][:8]} CALC DONE: Rp {grand_total}")
        except Exception as e:
            print(f"⚠️ [Processor] Error: {e}")
        time.sleep(5)

# ─── MAIN ────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    # Start background threads
    threading.Thread(target=payment_watcher, daemon=True).start()
    threading.Thread(target=pricing_processor, daemon=True).start()
    
    # Start Flask API
    print("🚀 worker.py is running (API + Watcher + Processor)")
    app.run(port=5000, debug=False)
