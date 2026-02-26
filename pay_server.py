from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import base64
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

SERVER_KEY = os.getenv("MIDTRANS_SERVER_KEY")
AUTH_HEADER = base64.b64encode(f"{SERVER_KEY}:".encode()).decode()

@app.route('/create-payment', methods=['POST'])
def create_payment():
    try:
        data = request.json
        job_id = data.get('jobId')
        amount = data.get('amount')
        contact = data.get('customer_contact') # Ambil kontak dari app.js

        payload = {
            "transaction_details": {
                "order_id": job_id,
                "gross_amount": int(amount)
            },
            "item_details": [{"id": "print-01", "price": int(amount), "quantity": 1, "name": "Cetak Dokumen"}],
            # Simpan kontak di custom_field agar bisa diambil oleh watcher
            "custom_field1": contact,
            "usage_limit": 1
        }

        headers = {
            "Authorization": f"Basic {AUTH_HEADER}",
            "Content-Type": "application/json",
            "Accept": "application/json"
        }

        response = requests.post(
            "https://app.sandbox.midtrans.com/snap/v1/transactions",
            json=payload,
            headers=headers
        )
        
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    print("🚀 Payment Bridge Server berjalan di http://localhost:5000")
    app.run(port=5000)