const SUPABASE_URL = "https://fyfmeeaifqvmqnbbmnvm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5Zm1lZWFpZnF2bXFuYmJtbnZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4MjE2NjQsImV4cCI6MjA4NzM5NzY2NH0.jV2Fjs2Sh6lU_pFvArdgDpYA_GSL-7FWmonksMcIhnY";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- CONFIGURATION ---
// Jika anda menggunakan GitHub Pages, ganti URL di bawah dengan URL HTTPS (misal dari ngrok)
const EXTERNAL_BACKEND_URL = "https://giant-beans-stare.loca.lt";

const BACKEND_URL = EXTERNAL_BACKEND_URL || (
    (window.location.hostname && !['localhost', '127.0.0.1', 'fajardamanik.github.io'].includes(window.location.hostname))
        ? `http://${window.location.hostname}:5000`
        : 'http://localhost:5000'
);

let temporaryContact = "";
let itemsRendered = false;
let wasLocked = false;
let pendingFiles = []; // Format: { file, md5, itemId }
let isUploadingPostPayment = false;
let globalProducts = [];
let currentJobId = null; // Tracking untuk polling aktif

document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const jobId = new URLSearchParams(window.location.search).get('jobId');

    if (dropZone && fileInput) {
        dropZone.onclick = () => fileInput.click();
        fileInput.onchange = (e) => handleFiles(e.target.files);

        // Drag & drop support
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('bg-blue-50');
        });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('bg-blue-50'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('bg-blue-50');
            handleFiles(e.dataTransfer.files);
        });
    }

    if (jobId) {
        initStatusView(jobId);
    }
});

async function initStatusView(jobId) {
    currentJobId = jobId; // Tandai sebagai job aktif
    document.getElementById('upload-section').classList.add('hidden');
    document.getElementById('status-section').classList.remove('hidden');
    document.getElementById('display-jobid').innerText = `ID: ${jobId.substring(0, 8).toUpperCase()}`;

    // Await produk agar globalProducts terisi sebelum pollStatus merender tabel
    await loadPackaging();
    pollStatus(jobId);

    const contactInput = document.getElementById('contact-input');
    if (contactInput) {
        // Remove old listener if any to avoid duplicates
        const newContactInput = contactInput.cloneNode(true);
        contactInput.parentNode.replaceChild(newContactInput, contactInput);

        newContactInput.addEventListener('input', (e) => {
            const val = e.target.value.replace(/\D/g, '');
            if (val.length >= 10) {
                temporaryContact = val;
                document.getElementById('midtrans-container').classList.remove('hidden');
            } else {
                document.getElementById('midtrans-container').classList.add('hidden');
            }
        });
    }
}

// ─── UPLOAD PROGRESS BAR ───────────────────────────────────────────────────
function showProgress(show) {
    document.getElementById('progress-wrapper').classList.toggle('hidden', !show);
}

function setProgress(value, label) {
    const bar = document.getElementById('progress-bar');
    const text = document.getElementById('progress-text');
    if (bar) bar.style.width = `${value}%`;
    if (text) text.innerText = label;
}

// ─── MD5 CALCULATION ──────────────────────────────────────────────────────
async function computeMD5(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const hex = SparkMD5.ArrayBuffer.hash(e.target.result);
            resolve(hex);
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

// ─── HANDLE FILE SELECTION ─────────────────────────────────────────────────
async function handleFiles(files) {
    if (files.length === 0) return;

    const jobId = crypto.randomUUID();
    const dropZone = document.getElementById('drop-zone');

    if (dropZone) dropZone.onclick = null;
    showProgress(true);
    setProgress(5, `Menganalisis file...`);

    // 1. Buat Header Job
    const { error: jobError } = await supabaseClient
        .from('print_jobs')
        .insert([{ id: jobId, status: 'pending', total_price: 0 }]);

    if (jobError) {
        console.error('❌ Gagal membuat job:', jobError);
        setProgress(100, `❌ Gagal: ${jobError.message}`);
        return;
    }

    pendingFiles = []; // Reset list
    const total = files.length;

    // 2. Analisis & Hitung MD5 (Pre-Payment)
    for (let i = 0; i < total; i++) {
        const file = files[i];
        const pct = 10 + Math.round((i / total) * 80);
        setProgress(pct, `Menganalisis ${i + 1}/${total}: ${file.name}`);

        try {
            const md5 = await computeMD5(file);
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch(`${BACKEND_URL}/analyze`, {
                method: 'POST',
                headers: { 'Bypass-Tunnel-Reminder': 'true' },
                body: formData
            });
            const data = await res.json();
            if (data.status !== "success") throw new Error(data.error || "Gagal analisis");

            const meta = data.metadata;
            const itemId = crypto.randomUUID();

            const { error: itemError } = await supabaseClient
                .from('print_job_items')
                .insert([{
                    id: itemId,
                    job_id: jobId,
                    file_name: file.name,
                    pages: meta.pages,
                    ink_c: meta.ink_c,
                    ink_m: meta.ink_m,
                    ink_y: meta.ink_y,
                    ink_k: meta.ink_k,
                    print_mode: (meta.ink_c > 0 || meta.ink_m > 0 || meta.ink_y > 0) ? 'color' : 'bw',
                    price: 0,
                    md5_hash: md5
                }]);

            if (itemError) throw itemError;
            pendingFiles.push({ file, md5, itemId });
        } catch (err) {
            console.error(`❌ Error pada ${file.name}:`, err);
            setProgress(100, `⚠️ Error: ${err.message}`);
            return;
        }
    }

    setProgress(100, `✅ Analisis selesai!`);

    // Ganti URL tanpa reload agar pendingFiles tidak hilang
    const newPath = window.location.pathname + '?jobId=' + jobId;
    window.history.pushState({ jobId }, '', newPath);

    // Langsung pindah tampilan (SPA)
    initStatusView(jobId);

    // Tambah proteksi agar window tidak sengaja tertutup saat proses bayar (karena file ada di RAM)
    window.onbeforeunload = () => "Anda memiliki proses cetak yang sedang berlangsung. Jangan tutup halaman ini sampai file terupload otomatis setelah pembayaran.";
}

// ─── POLL STATUS ───────────────────────────────────────────────────────────
async function pollStatus(id) {
    // HENTIKAN jika id tidak sama dengan currentJobId (berarti sudah di-reset/ganti job)
    if (id !== currentJobId) return;

    const { data: job, error } = await supabaseClient
        .from('print_jobs')
        .select('*, print_job_items(*)')
        .eq('id', id)
        .single();

    if (error) {
        console.error('❌ Gagal fetch job:', error);
        // Coba lagi dalam 3 detik
        setTimeout(() => pollStatus(id), 3000);
        return;
    }

    if (!job) {
        console.warn('⚠️ Job belum ditemukan, mencoba lagi...');
        setTimeout(() => pollStatus(id), 3000);
        return;
    }

    const listBody = document.getElementById('file-list-body');
    const tag = document.getElementById('status-tag');
    const isLocked = job.status === 'calculating' || job.total_price > 0 || job.status === 'paid';
    const hasItems = job.print_job_items && job.print_job_items.length > 0;

    // Render baris item (File & Kemasan)
    const justLocked = isLocked && !wasLocked;
    if (hasItems && listBody && (!itemsRendered || justLocked)) {
        listBody.innerHTML = job.print_job_items.map(item => {
            const isPackaging = !item.md5_hash; // Item kemasan tidak punya hash
            const rowClass = isPackaging ? "border-b bg-gray-50/50" : "border-b";
            const nameClass = isPackaging ? "py-3 text-sm font-medium text-gray-600 italic" : "py-3 text-sm font-medium text-gray-700";
            const typeLabel = isPackaging ? "FOLDER" : (item.print_mode === 'color' ? "🌈 Warna" : "🌑 BW");

            return `
                <tr class="${rowClass}">
                    <td class="${nameClass}">${isPackaging ? 'Kemasan Cetak' : item.file_name}</td>
                    <td class="py-3 text-center text-[10px] ${isPackaging ? 'text-gray-400 font-bold' : ''}">
                        ${isPackaging ? item.file_name.toUpperCase() : `
                            <select id="mode-${item.id}" ${isLocked ? 'disabled' : ''} class="text-xs border rounded p-1">
                                <option value="bw" ${item.print_mode === 'bw' ? 'selected' : ''}>🌑 BW</option>
                                <option value="color" ${item.print_mode === 'color' ? 'selected' : ''}>🌈 Warna</option>
                            </select>
                        `}
                    </td>
                    <td class="py-3 text-right font-mono font-bold" id="price-${item.id}">
                        ${item.price > 0 ? `Rp ${item.price.toLocaleString()}` : '<span class="animate-pulse text-gray-400">...</span>'}
                    </td>
                </tr>
            `;
        }).join('');

        itemsRendered = true;
        wasLocked = isLocked;
    } else if (hasItems && itemsRendered) {
        // Update hanya kolom harga tanpa menyentuh dropdown
        job.print_job_items.forEach(item => {
            const cell = document.getElementById(`price-${item.id}`);
            if (cell && item.price > 0) cell.innerText = `Rp ${item.price.toLocaleString()}`;
        });
    } else if (listBody && !hasItems) {
        listBody.innerHTML = `<tr><td colspan="3" class="py-6 text-center text-gray-400 animate-pulse">Memuat file...</td></tr>`;
    }

    // Lock/Unlock Packaging Select & Hide Section if Locked
    const pkgSelect = document.getElementById('packaging-select');
    const pkgSection = document.getElementById('packaging-section');
    if (pkgSelect) {
        pkgSelect.disabled = isLocked;
        // Jika belum terpilih di UI, tapi sudah ada di database (refresh)
        if (!pkgSelect.value) {
            const pkgItem = job.print_job_items?.find(item => !item.md5_hash);
            if (pkgItem) {
                // Cari ID produk berdasarkan namanya (file_name) di globalProducts
                const product = globalProducts.find(p => p.nama === pkgItem.file_name);
                if (product) pkgSelect.value = product.id;
            }
        }
    }
    if (pkgSection) {
        // Jika sudah lunas/confirmed, sembunyikan section pilih kemasan karena sudah ada di tabel
        if (isLocked) {
            pkgSection.classList.add('opacity-75'); // Visual feedback it's locked
            if (job.total_price > 0 || ['calculating', 'paid', 'confirmed', 'ready', 'picked_up'].includes(job.status)) {
                pkgSection.classList.add('hidden');
            }
        } else {
            pkgSection.classList.remove('hidden', 'opacity-75');
        }
    }

    // Update status tag
    if (job.status === 'confirmed') {
        tag.innerText = "ANTRIAN CETAK";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-green-100 text-green-700 uppercase";
    } else if (job.status === 'ready') {
        tag.innerText = "SIAP AMBIL";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-700 uppercase";
    } else if (job.status === 'paid') {
        tag.innerText = "SEDANG MENGIRIM FILE...";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-yellow-100 text-yellow-700 uppercase animate-pulse";
    } else if (job.status === 'calculating') {
        tag.innerText = "SEDANG MENGHITUNG...";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-yellow-100 text-yellow-700 animate-pulse";
    } else if (job.total_price > 0) {
        tag.innerText = "SIAP BAYAR";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-green-100 text-green-700";
    } else if (hasItems) {
        tag.innerText = "PILIH MODE CETAK";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700";
    } else {
        tag.innerText = "MENGANALISIS...";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700 animate-pulse";
    }

    // Tampilkan total harga jika sudah tersedia
    if (job.total_price > 0) {
        const totalContainer = document.getElementById('total-container');
        const totalDisp = document.getElementById('display-total-price');
        if (totalContainer) totalContainer.classList.remove('hidden');
        if (totalDisp) totalDisp.innerText = `Rp ${job.total_price.toLocaleString()}`;
    }

    // Tampil/sembunyikan tombol konfirmasi & kontak
    const postPayment = ['paid', 'confirmed', 'ready', 'picked_up'].includes(job.status);

    if (job.total_price === 0 && job.status === 'pending' && hasItems) {
        document.getElementById('calc-container').classList.remove('hidden');
    } else {
        document.getElementById('calc-container').classList.add('hidden');
        if (postPayment) {
            document.getElementById('contact-container').classList.add('hidden');
        } else {
            document.getElementById('contact-container').classList.remove('hidden');
        }
    }

    // Tampilkan Success Message jika CONFIRMED
    if (job.status === 'confirmed' || job.status === 'ready' || job.status === 'picked_up') {
        const successCont = document.getElementById('success-container');
        if (successCont) {
            successCont.classList.remove('hidden');
            const contactDisplay = document.getElementById('display-contact');
            if (contactDisplay) contactDisplay.innerText = job.contact || temporaryContact || "-";

            // Sembunyikan progress bar jika sudah selesai
            showProgress(false);
        }
    }

    // Polling lanjut sampai selesai
    if (job.status !== 'picked_up') {
        setTimeout(() => pollStatus(id), 4000);
    }

    // Trigger upload jika status bayar terdeteksi
    if (job.status === 'paid' && pendingFiles.length > 0 && !isUploadingPostPayment) {
        console.log("🚀 Status PAID terdeteksi. Memulai upload file...");
        uploadPendingFiles(id);
    }
}

// ─── UPLOAD SETELAH BAYAR (POST-PAYMENT) ────────────────────────────────────
async function uploadPendingFiles(jobId) {
    if (isUploadingPostPayment) return;
    if (pendingFiles.length === 0) {
        console.warn("⚠️ uploadPendingFiles dipanggil tapi pendingFiles kosong.");
        return;
    }

    console.log(`📦 Memulai proses upload untuk ${pendingFiles.length} file...`);
    isUploadingPostPayment = true;

    showProgress(true);
    setProgress(0, "Pembayaran Dikonfirmasi! Mengirim file ke antrean cetak...");

    const total = pendingFiles.length;
    for (let i = 0; i < total; i++) {
        const { file, md5, itemId } = pendingFiles[i];
        const storageName = `${Date.now()}_${file.name}`;

        console.log(`📤 Uploading (${i + 1}/${total}): ${file.name} (Hash: ${md5})`);
        const pct = Math.round((i / total) * 100);
        setProgress(pct, `Mengirim ${i + 1}/${total}: ${file.name}`);

        try {
            // 1. Upload ke Storage
            const { error: storageError } = await supabaseClient.storage
                .from('documents')
                .upload(storageName, file);

            if (storageError) throw storageError;

            // 2. Update print_job_items dengan storage_name
            const { error: updateError } = await supabaseClient
                .from('print_job_items')
                .update({ storage_name: storageName })
                .eq('id', itemId);

            if (updateError) throw updateError;

            console.log(`✅ File ${file.name} berhasil diupload.`);
        } catch (err) {
            console.error(`❌ Gagal mengirim file ${file.name}:`, err);
            setProgress(100, `⚠️ Error Pengiriman: ${err.message}. Jangan tutup halaman!`);
            isUploadingPostPayment = false;
            return;
        }
    }

    console.log("🏁 Semua file berhasil dikirim. Menyetel status ke CONFIRMED...");
    setProgress(100, "✅ Selesai! Dokumen Anda sudah masuk antrean.");

    // 3. Update Status Job ke 'confirmed' agar Admin tahu file sudah lengkap
    const { error: finalError } = await supabaseClient
        .from('print_jobs')
        .update({ status: 'confirmed' })
        .eq('id', jobId);

    if (finalError) console.error("❌ Gagal update status akhir:", finalError);

    isUploadingPostPayment = false;
    pendingFiles = []; // Kosongkan setelah sukses
    window.onbeforeunload = null; // Lepas proteksi
}

// ─── LOAD PACKAGING OPTIONS ────────────────────────────────────────────────
async function loadPackaging() {
    const select = document.getElementById('packaging-select');
    if (!select) return;

    const { data: products, error } = await supabaseClient
        .from('products')
        .select('*');

    console.log("DEBUG: All products from DB:", products);
    console.log("DEBUG: Filtered (Folder):", products ? products.filter(p => p.jenis === 'Folder') : []);

    if (error) {
        console.error('❌ Gagal fetch products:', error);
        return;
    }

    globalProducts = products; // Simpan untuk pollStatus

    // Reset select options agar tidak double saat ganti job (SPA)
    select.innerHTML = '<option value="">Nanti Saja</option>';

    const folders = products.filter(p => p.jenis === 'Folder');
    folders.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.innerText = `${p.nama} (+Rp ${p.harga.toLocaleString()})`;
        select.appendChild(opt);
    });
}

// ─── HITUNG BIAYA ──────────────────────────────────────────────────────────
async function hitungBiaya() {
    const jobId = new URLSearchParams(window.location.search).get('jobId');
    if (!jobId) { alert('Job ID tidak ditemukan!'); return; }

    const packagingId = document.getElementById('packaging-select').value;
    const btn = document.querySelector('#calc-container button');
    if (btn) { btn.disabled = true; btn.innerText = '⏳ Memproses...'; }

    try {
        // 1. Update Mode di items PDF
        const selects = document.querySelectorAll('select[id^="mode-"]');
        for (let sel of selects) {
            const itemId = sel.id.replace('mode-', '');
            const { error } = await supabaseClient
                .from('print_job_items')
                .update({ print_mode: sel.value })
                .eq('id', itemId);
            if (error) throw new Error(`Gagal update item: ${error.message}`);
        }

        // 2. Jika ada kemasan, masukkan sebagai baris baru di print_job_items
        if (packagingId) {
            const pkg = globalProducts.find(p => p.id === packagingId);
            if (pkg) {
                const { error: pkgError } = await supabaseClient
                    .from('print_job_items')
                    .insert({
                        job_id: jobId,
                        file_name: pkg.nama,
                        price: pkg.harga,
                        pages: 0,
                        ink_c: 0, ink_m: 0, ink_y: 0, ink_k: 0,
                        print_mode: 'color'
                    });
                if (pkgError) throw new Error(`Gagal tambah kemasan: ${pkgError.message}`);
            }
        }

        // 3. Set status job saja
        const { error: jobError } = await supabaseClient
            .from('print_jobs')
            .update({ status: 'calculating' })
            .eq('id', jobId);
        if (jobError) throw new Error(`Gagal update status job: ${jobError.message}`);

        if (btn) btn.innerText = '✅ Dikirim!';
    } catch (err) {
        console.error('❌ hitungBiaya error:', err);
        alert(`❌ ${err.message}`);
        if (btn) { btn.disabled = false; btn.innerText = '🧮 KONFIRMASI & HITUNG BIAYA'; }
    }
}

// ─── BUKA MIDTRANS ─────────────────────────────────────────────────────────
async function bukaMidtrans() {
    const jobId = new URLSearchParams(window.location.search).get('jobId');
    const totalHarga = parseInt(document.getElementById('display-total-price').innerText.replace(/\D/g, ''));

    const response = await fetch(`${BACKEND_URL}/create-payment`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Bypass-Tunnel-Reminder': 'true'
        },
        body: JSON.stringify({ jobId, amount: totalHarga, customer_contact: temporaryContact })
    });
    const data = await response.json();
    if (data.redirect_url) window.open(data.redirect_url, '_blank');
}

// ─── RESET PAGE ─────────────────────────────────────────────────────────────
function resetPage() {
    // Sederhanakan: Refresh halaman total untuk hapus semua cache & state
    // Redirect ke root tanpa query params (jobId)
    window.location.href = window.location.pathname;
}