const SUPABASE_URL = "https://fyfmeeaifqvmqnbbmnvm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5Zm1lZWFpZnF2bXFuYmJtbnZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4MjE2NjQsImV4cCI6MjA4NzM5NzY2NH0.jV2Fjs2Sh6lU_pFvArdgDpYA_GSL-7FWmonksMcIhnY";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let temporaryContact = "";
let itemsRendered = false;
let wasLocked = false;

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
        document.getElementById('upload-section').classList.add('hidden');
        document.getElementById('status-section').classList.remove('hidden');
        document.getElementById('display-jobid').innerText = `ID: ${jobId.substring(0, 8).toUpperCase()}`;
        pollStatus(jobId);

        document.getElementById('contact-input').addEventListener('input', (e) => {
            const val = e.target.value.replace(/\D/g, '');
            if (val.length >= 10) {
                temporaryContact = val;
                document.getElementById('midtrans-container').classList.remove('hidden');
            } else {
                document.getElementById('midtrans-container').classList.add('hidden');
            }
        });
    }
});

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

// ─── HANDLE FILE UPLOAD ────────────────────────────────────────────────────
async function handleFiles(files) {
    if (files.length === 0) return;

    const jobId = crypto.randomUUID();
    const dropZone = document.getElementById('drop-zone');

    // Nonaktifkan zona upload
    if (dropZone) dropZone.onclick = null;
    showProgress(true);
    setProgress(5, `Memulai upload...`);

    // 1. Buat Header Job
    const { error: jobError } = await supabaseClient
        .from('print_jobs')
        .insert([{ id: jobId, status: 'pending', total_price: 0 }]);

    if (jobError) {
        console.error('❌ Gagal membuat job:', jobError);
        setProgress(100, `❌ Gagal: ${jobError.message}`);
        document.getElementById('progress-bar').classList.add('bg-red-500');
        return;
    }

    setProgress(15, `Job dibuat. Mengupload file...`);

    // 2. Upload setiap file
    const total = files.length;
    for (let i = 0; i < total; i++) {
        const file = files[i];
        const storageName = `${Date.now()}_${file.name}`;
        const pct = 15 + Math.round(((i) / total) * 70);
        setProgress(pct, `Mengupload ${i + 1}/${total}: ${file.name}`);

        // Upload ke Storage
        const { error: storageError } = await supabaseClient.storage
            .from('documents')
            .upload(storageName, file);

        if (storageError) {
            console.error(`❌ Gagal upload file ${file.name}:`, storageError);
            setProgress(100, `❌ Gagal upload: ${storageError.message}`);
            document.getElementById('progress-bar').classList.add('bg-red-500');
            return;
        }

        // Insert ke print_job_items
        const { error: itemError } = await supabaseClient
            .from('print_job_items')
            .insert([{
                job_id: jobId,
                file_name: file.name,
                storage_name: storageName,
                print_mode: 'color'
            }]);

        if (itemError) {
            console.error(`❌ Gagal insert item ${file.name}:`, itemError);
            setProgress(100, `❌ Gagal simpan data: ${itemError.message}`);
            document.getElementById('progress-bar').classList.add('bg-red-500');
            return;
        }

        setProgress(15 + Math.round(((i + 1) / total) * 70), `File ${i + 1}/${total} selesai`);
    }

    setProgress(100, `✅ Semua file terupload! Mengalihkan...`);
    setTimeout(() => {
        window.location.search = `?jobId=${jobId}`;
    }, 800);
}

// ─── POLL STATUS ───────────────────────────────────────────────────────────
async function pollStatus(id) {
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

    // Render baris file HANYA saat pertama kali ada item, atau saat status baru terkunci
    const justLocked = isLocked && !wasLocked;
    if (hasItems && listBody && (!itemsRendered || justLocked)) {
        listBody.innerHTML = job.print_job_items.map(item => `
            <tr class="border-b">
                <td class="py-3 text-sm font-medium text-gray-700">${item.file_name}</td>
                <td class="py-3 text-center">
                    <select id="mode-${item.id}" ${isLocked ? 'disabled' : ''} class="text-xs border rounded p-1">
                        <option value="bw" ${item.print_mode === 'bw' ? 'selected' : ''}>🌑 BW</option>
                        <option value="color" ${item.print_mode === 'color' ? 'selected' : ''}>🌈 Warna</option>
                    </select>
                </td>
                <td class="py-3 text-right font-mono font-bold" id="price-${item.id}">
                    ${item.price > 0 ? `Rp ${item.price.toLocaleString()}` : '<span class="animate-pulse text-gray-400">...</span>'}
                </td>
            </tr>
        `).join('');
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

    // Update status tag
    if (job.status === 'calculating') {
        tag.innerText = "SEDANG MENGHITUNG...";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-yellow-100 text-yellow-700 animate-pulse";
    } else if (job.total_price > 0) {
        tag.innerText = job.status === 'paid' ? "LUNAS" : "SIAP BAYAR";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-green-100 text-green-700";
        document.getElementById('display-total-price').innerText = `Rp ${job.total_price.toLocaleString()}`;
    } else if (hasItems) {
        tag.innerText = "PILIH MODE CETAK";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700";
    } else {
        tag.innerText = "MENGANALISIS...";
        tag.className = "px-3 py-1 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700 animate-pulse";
    }

    // Tampil/sembunyikan tombol konfirmasi & kontak
    const postPayment = job.status === 'paid' || job.status === 'ready' || job.status === 'picked_up';

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

    // Polling lanjut
    if (job.status !== 'paid') setTimeout(() => pollStatus(id), 4000);
}

// ─── HITUNG BIAYA ──────────────────────────────────────────────────────────
async function hitungBiaya() {
    const jobId = new URLSearchParams(window.location.search).get('jobId');
    if (!jobId) { alert('Job ID tidak ditemukan!'); return; }

    const btn = document.querySelector('#calc-container button');
    if (btn) { btn.disabled = true; btn.innerText = '⏳ Memproses...'; }

    try {
        const selects = document.querySelectorAll('select[id^="mode-"]');
        for (let sel of selects) {
            const itemId = sel.id.replace('mode-', '');
            const { error } = await supabaseClient
                .from('print_job_items')
                .update({ print_mode: sel.value })
                .eq('id', itemId);
            if (error) throw new Error(`Gagal update item: ${error.message}`);
        }

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

    const response = await fetch('http://localhost:5000/create-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, amount: totalHarga, customer_contact: temporaryContact })
    });
    const data = await response.json();
    if (data.redirect_url) window.open(data.redirect_url, '_blank');
}