document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelectorAll('.nav-tab');
    const contentArea = document.getElementById('content-area');
    let currentTab = 'student_records';

    // Database UI Logic (Shared)
    const statusIndicator = document.getElementById('db-status-indicator');
    const dbDetails = document.getElementById('db-details');
    const btnCheck = document.getElementById('btn-check-db');
    const btnBackup = document.getElementById('btn-backup-db');
    const fileRestore = document.getElementById('file-restore-db');

    function updateStatus() {
        const status = window.studentDB.getStatus();
        if (status.status === 'Connected') {
            statusIndicator.innerText = '🟢 Connected';
            statusIndicator.style.color = 'green';
            dbDetails.innerText = `(${status.name} v${status.version})`;
            loadTab(currentTab); // Load data once connected
        } else {
            statusIndicator.innerText = '🔴 Disconnected';
            statusIndicator.style.color = 'red';
        }
    }

    window.addEventListener('db-ready', updateStatus);

    // Tab Switching
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentTab = tab.dataset.tab;
            loadTab(currentTab);
        });
    });

    async function loadTab(storeName) {
        contentArea.innerHTML = '<div class="loading">Loading...</div>';

        try {
            const records = await window.studentDB.getAllRecords(storeName);
            renderTable(storeName, records);
        } catch (err) {
            contentArea.innerHTML = `<p class="error">Error loading data: ${err}</p>`;
        }
    }

    function renderTable(storeName, records) {
        let html = `
            <div class="view-header">
                <h2>${formatName(storeName)}</h2>
                <button class="btn-primary add-btn" onclick="addNewRecord('${storeName}')">+ Add Record</button>
            </div>
        `;

        if (records.length === 0) {
            html += '<p>No records found. Add one to get started!</p>';
        } else {
            html += '<table class="data-table"><thead><tr>';

            // Get headers from first record keys, excluding internal keys if needed
            const headers = Object.keys(records[0]);
            headers.forEach(h => html += `<th>${formatName(h)}</th>`);

            html += '</tr></thead><tbody>';

            records.forEach(row => {
                html += '<tr>';
                headers.forEach(h => {
                    let val = row[h];
                    if (typeof val === 'object') val = JSON.stringify(val);
                    html += `<td>${val}</td>`;
                });
                html += '</tr>';
            });

            html += '</tbody></table>';
        }

        contentArea.innerHTML = html;
    }

    function formatName(str) {
        return str.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }

    // Global function for the Add button
    window.addNewRecord = async (storeName) => {
        // Simple prompt-based entry for now
        const data = {};
        const fields = getFieldsForStore(storeName);

        for (const field of fields) {
            const val = prompt(`Enter ${field}:`);
            if (val === null) return; // Cancelled
            data[field] = val;
        }

        try {
            await window.studentDB.addRecord(storeName, data);
            loadTab(storeName); // Reload
        } catch (err) {
            alert('Failed to add record: ' + err);
        }
    };

    function getFieldsForStore(storeName) {
        switch (storeName) {
            case 'student_records': return ['name', 'age', 'grade'];
            case 'triage': return ['student_name', 'symptoms', 'action_taken'];
            case 'attendance': return ['student_name', 'status', 'date'];
            case 'plans': return ['student_name', 'goal', 'activities'];
            default: return ['name', 'description'];
        }
    }

    // DB Controls Event Listeners
    btnCheck.addEventListener('click', () => {
        updateStatus();
        alert(JSON.stringify(window.studentDB.getStatus(), null, 2));
    });

    btnBackup.addEventListener('click', async () => {
        try {
            const json = await window.studentDB.exportBackup();
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `student_db_backup_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            alert('Export failed: ' + err);
        }
    });

    fileRestore.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                await window.studentDB.importBackup(event.target.result);
                alert('Database restored successfully!');
                updateStatus();
            } catch (err) {
                alert('Import failed: ' + err);
            }
        };
        reader.readAsText(file);
    });
});
