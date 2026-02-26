import time, requests, base64, os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY")
MIDTRANS_SERVER_KEY = os.getenv("MIDTRANS_SERVER_KEY")
FONNTE_TOKEN = os.getenv("FONNTE_TOKEN") 

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def get_auth_header():
    encoded_auth = base64.b64encode(f"{MIDTRANS_SERVER_KEY}:".encode()).decode()
    return {"Authorization": f"Basic {encoded_auth}", "Accept": "application/json"}

def send_whatsapp_notification(target, order_id):
    url = 'https://api.fonnte.com/send'
    data = {'target': target, 'message': f'Pembayaran Lunas! Dokumen ID {order_id[:8]} sedang dicetak. Silakan tunggu di depan kios.'}
    requests.post(url, data=data, headers={'Authorization': FONNTE_TOKEN})

def run_watcher():
    print("🔍 Watcher Pembayaran Aktif...")
    while True:
        try:
            res = supabase.table("print_jobs").select("*").eq("status", "pending").gt("total_price", 0).execute()
            for job in res.data:
                order_id = job['id']
                url = f"https://api.sandbox.midtrans.com/v2/{order_id}/status"
                response = requests.get(url, headers=get_auth_header())
                
                if response.status_code == 200:
                    data = response.json()
                    if data.get("transaction_status") in ["settlement", "capture", "success"]:
                        contact_info = data.get("custom_field1")
                        update_data = {"status": "paid"}
                        if contact_info: update_data["contact"] = contact_info
                        
                        supabase.table("print_jobs").update(update_data).eq("id", order_id).execute()
                        if contact_info: send_whatsapp_notification(contact_info, order_id)
                        print(f"✅ Job {order_id[:8]} LUNAS.")
        except Exception as e:
            print(f"⚠️ Error Watcher: {e}")
        time.sleep(10)

if __name__ == "__main__":
    run_watcher()