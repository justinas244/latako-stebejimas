<?php
// ============ KONFIGŪRACIJA ============
$db_config = [
    'host' => getenv('DB_HOST') ?: 'latakas-2c957c92-ku-7312.l.aivencloud.com',
    'port' => getenv('DB_PORT') ?: '26099',
    'user' => getenv('DB_USER') ?: 'avnadmin',
    'password' => getenv('DB_PASSWORD') ?: 'AVNS_O218wwrMWicUdZRG7EK',
    'database' => getenv('DB_NAME') ?: 'defaultdb'
];

date_default_timezone_set('Europe/Vilnius');

// Prisijungimas prie MySQL
try {
    $pdo = new PDO(
        "mysql:host={$db_config['host']};port={$db_config['port']};dbname={$db_config['database']};charset=utf8mb4",
        $db_config['user'],
        $db_config['password'],
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::MYSQL_ATTR_SSL_CA => '',
            PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => false
        ]
    );
} catch(PDOException $e) {
    http_response_code(500);
    die(json_encode(['error' => 'MySQL klaida: ' . $e->getMessage()]));
}

// Lentelių sukūrimas
try {
    $pdo->exec("CREATE TABLE IF NOT EXISTS `batch_measurements` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `water_levels` JSON NOT NULL,
        `distances` JSON NOT NULL,
        `measurement_count` INT NOT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )");
    
    $pdo->exec("CREATE TABLE IF NOT EXISTS `system_state` (
        `id` INT AUTO_INCREMENT PRIMARY KEY,
        `is_recording` BOOLEAN DEFAULT FALSE,
        `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )");
    
    $stmt = $pdo->query("SELECT COUNT(*) as count FROM system_state");
    if ($stmt->fetchColumn() == 0) {
        $pdo->exec("INSERT INTO system_state (is_recording) VALUES (FALSE)");
    }
} catch(PDOException $e) {
    // Lentelės jau egzistuoja
}

// ============ FUNKCIJOS ============
function getRecordingState($pdo) {
    $stmt = $pdo->query("SELECT is_recording FROM system_state ORDER BY id DESC LIMIT 1");
    $result = $stmt->fetch(PDO::FETCH_ASSOC);
    return $result ? (bool)$result['is_recording'] : false;
}

function setRecordingState($pdo, $state) {
    $state = $state ? 1 : 0;
    $stmt = $pdo->prepare("UPDATE system_state SET is_recording = ? ORDER BY id DESC LIMIT 1");
    return $stmt->execute([$state]);
}

function clearAllMeasurements($pdo) {
    $stmt = $pdo->prepare("DELETE FROM batch_measurements");
    return $stmt->execute();
}

function getStatistics($pdo) {
    $stmt = $pdo->query("SELECT water_levels FROM batch_measurements ORDER BY id DESC LIMIT 1000");
    $allData = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    $allLevels = [];
    foreach ($allData as $batch) {
        $levels = json_decode($batch['water_levels'], true);
        $allLevels = array_merge($allLevels, $levels);
    }
    
    if (count($allLevels) == 0) {
        return ['avg' => 0, 'max' => 0, 'min' => 0, 'count' => 0, 'current' => 0];
    }
    
    return [
        'current' => end($allLevels),
        'avg' => round(array_sum($allLevels) / count($allLevels), 2),
        'max' => round(max($allLevels), 2),
        'min' => round(min($allLevels), 2),
        'count' => count($allLevels)
    ];
}

// Siųsti žinutę visiems WebSocket klientams
function broadcastToWebSocket($message) {
    $socketPath = __DIR__ . '/websocket.sock';
    if (!file_exists($socketPath)) return;
    
    try {
        $client = stream_socket_client('unix://' . $socketPath);
        if ($client) {
            fwrite($client, json_encode($message) . "\n");
            fclose($client);
        }
    } catch(Exception $e) {
        // Ignoruoti klaidas (WebSocket serveris gali būti nepasileidęs)
    }
}

// ============ API ENDPOINTS ============
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // 1. Wemos siunčia BATCH'ą
    if (isset($_POST['batch'])) {
        $batchData = json_decode($_POST['batch'], true);
        
        if (!$batchData || !isset($batchData['water_levels'])) {
            echo json_encode(['status' => 'Klaida', 'error' => 'Neteisingas formatas']);
            exit;
        }
        
        $water_levels = json_encode($batchData['water_levels']);
        $distances = isset($batchData['distances']) ? json_encode($batchData['distances']) : json_encode([]);
        $count = count($batchData['water_levels']);
        
        if (getRecordingState($pdo)) {
            $stmt = $pdo->prepare("INSERT INTO batch_measurements (water_levels, distances, measurement_count) VALUES (?, ?, ?)");
            $stmt->execute([$water_levels, $distances, $count]);
            $lastId = $pdo->lastInsertId();
            
            // Suformuojame matavimus siuntimui per WebSocket
            $levels = $batchData['water_levels'];
            $baseTime = time();
            $interval = 0.5;
            $measurements = [];
            
            for ($i = 0; $i < count($levels); $i++) {
                $time = date('Y-m-d H:i:s', $baseTime + ($i * $interval));
                $measurements[] = [
                    'id' => $lastId . '_' . $i,
                    'water_level' => $levels[$i],
                    'created_at' => $time
                ];
            }
            
            // Siunčiame per WebSocket visiems prisijungusiems klientams
            broadcastToWebSocket(['type' => 'new_data', 'data' => $measurements]);
            
            echo json_encode(['status' => 'Gauta', 'saved' => true, 'count' => $count]);
        } else {
            echo json_encode(['status' => 'Ignoruota', 'saved' => false, 'reason' => 'Recording disabled']);
        }
        exit;
    }
    
    // Kiti API veiksmai
    if (isset($_POST['action'])) {
        switch($_POST['action']) {
            case 'start':
                setRecordingState($pdo, true);
                broadcastToWebSocket(['type' => 'status_change', 'recording' => true]);
                echo json_encode(['success' => true, 'recording' => true]);
                break;
            case 'stop':
                setRecordingState($pdo, false);
                broadcastToWebSocket(['type' => 'status_change', 'recording' => false]);
                echo json_encode(['success' => true, 'recording' => false]);
                break;
            case 'clear':
                clearAllMeasurements($pdo);
                broadcastToWebSocket(['type' => 'clear']);
                echo json_encode(['success' => true, 'cleared' => true]);
                break;
            case 'get_status':
                echo json_encode(['recording' => getRecordingState($pdo)]);
                break;
            case 'get_stats':
                echo json_encode(getStatistics($pdo));
                break;
            case 'get_data':
                $stmt = $pdo->query("SELECT water_levels, created_at FROM batch_measurements ORDER BY created_at ASC LIMIT 5000");
                $batchData = $stmt->fetchAll(PDO::FETCH_ASSOC);
                $allMeasurements = [];
                foreach ($batchData as $batch) {
                    $water_levels = json_decode($batch['water_levels'], true);
                    $baseTime = strtotime($batch['created_at']);
                    foreach ($water_levels as $i => $level) {
                        $time = date('Y-m-d H:i:s', $baseTime + ($i * 0.5));
                        $allMeasurements[] = ['water_level' => $level, 'created_at' => $time];
                    }
                }
                echo json_encode($allMeasurements);
                break;
            default:
                echo json_encode(['error' => 'Nežinomas veiksmas']);
        }
        exit;
    }
}

// Eksportas į CSV
if (isset($_GET['export']) && $_GET['export'] === 'excel') {
    $stmt = $pdo->query("SELECT water_levels, created_at FROM batch_measurements ORDER BY created_at ASC");
    $batchData = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="vandens_lygis_' . date('Y-m-d_H-i-s') . '.csv"');
    
    $output = fopen('php://output', 'w');
    fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));
    fputcsv($output, ['Vandens lygis (cm)', 'Laikas']);
    
    foreach ($batchData as $batch) {
        $water_levels = json_decode($batch['water_levels'], true);
        $baseTime = strtotime($batch['created_at']);
        foreach ($water_levels as $i => $level) {
            $time = date('Y-m-d H:i:s', $baseTime + ($i * 0.5));
            fputcsv($output, [number_format($level, 2, '.', ''), $time]);
        }
    }
    fclose($output);
    exit;
}

// Jei ne API užklausa - grąžinti frontendą
if (file_exists(__DIR__ . '/public/index.html')) {
    readfile(__DIR__ . '/public/index.html');
} else {
    echo "Frontend failas nerastas. Įsitikinkite, kad public/index.html egzistuoja.";
}
?>