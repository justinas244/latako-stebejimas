let chart, currentData = [];
let ws = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;

function initChart() {
    const ctx = document.getElementById('waterChart').getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Vandens lygis (cm)', data: [], borderColor: '#667eea', backgroundColor: 'rgba(102,126,234,0.1)', tension: 0.2, fill: true }] },
        options: { responsive: true, maintainAspectRatio: true, animation: { duration: 200 }, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true, title: { display: true, text: 'cm' } }, x: { ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 15 } } } }
    });
}

function updateUI() {
    if (!currentData.length) return;
    const levels = currentData.map(d => d.water_level);
    document.getElementById('currentLevel').innerText = levels[levels.length-1].toFixed(2) + ' cm';
    document.getElementById('avgLevel').innerText = (levels.reduce((a,b)=>a+b,0)/levels.length).toFixed(2) + ' cm';
    document.getElementById('maxLevel').innerText = Math.max(...levels).toFixed(2) + ' cm';
    document.getElementById('minLevel').innerText = Math.min(...levels).toFixed(2) + ' cm';
    document.getElementById('totalMeasurements').innerText = currentData.length;
    
    const labels = currentData.map(d => new Date(d.created_at).toLocaleTimeString());
    const values = levels;
    const maxPoints = 200;
    
    if (labels.length > maxPoints) {
        chart.data.labels = labels.slice(-maxPoints);
        chart.data.datasets[0].data = values.slice(-maxPoints);
    } else {
        chart.data.labels = labels;
        chart.data.datasets[0].data = values;
    }
    chart.update();
}

function updateTable() {
    if (!currentData.length) { $('#tableBody').html('<tr><td colspan="2">Nėra duomenų</td></tr>'); return; }
    let html = '';
    currentData.slice(-20).reverse().forEach(item => {
        html += `<tr><td>${item.water_level.toFixed(2)} cm</td><td>${new Date(item.created_at).toLocaleString('lt-LT')}</td></tr>`;
    });
    $('#tableBody').html(html);
}

function addNewMeasurements(measurements) {
    if (!measurements || measurements.length === 0) return;
    currentData.push(...measurements);
    updateUI();
    updateTable();
    
    $('.chart-container').addClass('new-data');
    setTimeout(() => $('.chart-container').removeClass('new-data'), 300);
}

function loadHistory() {
    $.post(window.location.href, { action: 'get_data' }, function(data) {
        if (data && Array.isArray(data)) { 
            currentData = data; 
            updateUI(); 
            updateTable();
        }
    }, 'json');
}

function loadStatus() {
    $.post(window.location.href, { action: 'get_status' }, function(data) {
        if (data.recording) {
            $('#status').removeClass('status-stopped').addClass('status-recording').html('🔴 ĮRAŠYMAS VYKSTA');
        } else {
            $('#status').removeClass('status-recording').addClass('status-stopped').html('⭕ ĮRAŠYMAS SUSTABDYTA');
        }
    }, 'json');
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = function() {
        console.log('WebSocket prisijungė');
        $('#wsBadge').html('🔌 WebSocket: PRISIJUNGTA').css('background', '#28a745');
        $('#connectionStatus').html('🟢 WebSocket: Prisijungta').css('background', '#28a745');
        reconnectAttempts = 0;
    };
    
    ws.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'new_data' && data.data) {
                addNewMeasurements(data.data);
            } else if (data.type === 'status_change') {
                loadStatus();
            } else if (data.type === 'clear') {
                currentData = [];
                updateUI();
                updateTable();
            }
        } catch(e) {
            console.error('Klaida apdorojant WebSocket žinutę:', e);
        }
    };
    
    ws.onclose = function() {
        console.log('WebSocket atsijungė');
        $('#wsBadge').html('🔌 WebSocket: ATSIJUNGĘS').css('background', '#dc3545');
        $('#connectionStatus').html('🔴 WebSocket: Atsijungęs, bandoma prisijungti...').css('background', '#dc3545');
        
        if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            setTimeout(connectWebSocket, 3000);
        }
    };
    
    ws.onerror = function(error) {
        console.error('WebSocket klaida:', error);
    };
}

function sendAction(action) {
    $.post(window.location.href, { action: action }, function(data) {
        if (data.success) {
            if (action === 'clear') {
                currentData = [];
                updateUI();
                updateTable();
            }
            loadStatus();
        }
    }, 'json');
}

$(document).ready(function() { 
    initChart(); 
    loadHistory(); 
    loadStatus();
    connectWebSocket();
    
    $('#startBtn').click(() => sendAction('start'));
    $('#stopBtn').click(() => sendAction('stop'));
    $('#clearBtn').click(() => { if (confirm('Ar tikrai norite išvalyti visus duomenis?')) sendAction('clear'); });
    $('#exportBtn').click(() => window.location.href = window.location.href + '?export=excel');
});