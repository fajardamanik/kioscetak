import os, subprocess, time
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

URL = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(URL, KEY)

def analyze_pdf(path):
    try:
        cmd = ["gs", "-q", "-o", "-", "-sDEVICE=inkcov", path]
        res = subprocess.run(cmd, capture_output=True, text=True)
        lines = res.stdout.strip().split('\n')
        pages, c, m, y, k = 0, 0.0, 0.0, 0.0, 0.0
        for line in lines:
            p = line.split()
            if len(p) >= 4:
                pages += 1
                c += float(p[0]); m += float(p[1]); y += float(p[2]); k += float(p[3])
        return {"pages": pages, "c": c/pages, "m": m/pages, "y": y/pages, "k": k/pages} if pages > 0 else None
    except: return None

def run():
    print("🚀 Processor Aktif (One-to-Many Mode)...")
    while True:
        try:
            # Ambil Job yang minta dihitung
            jobs = supabase.table("print_jobs").select("*, print_job_items(*)").eq("status", "calculating").execute().data
            sett = supabase.table("settings").select("*").eq("id", 1).single().execute().data

            for job in jobs:
                grand_total = 0
                for item in job['print_job_items']:
                    # 1. Analisis jika data teknis belum ada
                    if not item.get('pages'):
                        path = f"temp_{item['id']}.pdf"
                        with open(path, "wb") as f:
                            f.write(supabase.storage.from_("documents").download(item['storage_name']))
                        
                        analysis = analyze_pdf(path)
                        if analysis:
                            item.update({"pages": analysis['pages'], "ink_c": analysis['c'], "ink_m": analysis['m'], "ink_y": analysis['y'], "ink_k": analysis['k']})
                        if os.path.exists(path): os.remove(path)

                    # 2. Hitung Harga
                    pages = item.get('pages', 1)
                    p_paper = pages * float(sett['paper_price'])
                    ink_c = item.get('ink_c', 0) or 0
                    ink_m = item.get('ink_m', 0) or 0
                    ink_y = item.get('ink_y', 0) or 0
                    ink_k = item.get('ink_k', 0) or 0

                    if item['print_mode'] == 'bw':
                        # BW/Grayscale: semua CMY dikonversi ke K ekuivalen pakai bobot luminansi
                        # gray_equiv = 0.299×C + 0.587×M + 0.114×Y (standar luminansi)
                        gray_equiv_k = ink_k + (0.299 * ink_c + 0.587 * ink_m + 0.114 * ink_y)
                        p_ink = gray_equiv_k * float(sett['black_ink_price'])
                    else:
                        # Color: bayar CMY + K berdasarkan coverage aktual
                        p_ink = (ink_c + ink_m + ink_y) * float(sett['color_ink_price']) + ink_k * float(sett['black_ink_price'])
                    
                    price = round(p_paper + p_ink)
                    grand_total += price

                    # 3. Simpan ke Database (Tabel Items)
                    supabase.table("print_job_items").update({
                        "pages": pages, "price": price,
                        "ink_c": item.get('ink_c', 0), "ink_m": item.get('ink_m', 0), "ink_y": item.get('ink_y', 0), "ink_k": item.get('ink_k', 0)
                    }).eq("id", item['id']).execute()

                # 4. Update Total di Tabel Parent
                supabase.table("print_jobs").update({"total_price": grand_total, "status": "pending"}).eq("id", job['id']).execute()
                print(f"✅ Job {job['id'][:8]} Selesai: Rp {grand_total}")

        except Exception as e:
            print(f"⚠️ Error: {e}")
        time.sleep(5)

if __name__ == "__main__":
    run()