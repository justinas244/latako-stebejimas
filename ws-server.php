<?php
// WebSocket serveris realaus laiko atnaujinimams (be Redis)
use Ratchet\MessageComponentInterface;
use Ratchet\ConnectionInterface;

require_once __DIR__ . '/vendor/autoload.php';

class WebSocketServer implements MessageComponentInterface {
    protected $clients;
    protected $socketPath = __DIR__ . '/websocket.sock';
    protected $socketServer;
    
    public function __construct() {
        $this->clients = new \SplObjectStorage;
        $this->setupUnixSocket();
    }
    
    protected function setupUnixSocket() {
        // Pašaliname seną socket failą
        if (file_exists($this->socketPath)) {
            unlink($this->socketPath);
        }
        
        // Sukuriame Unix socket serverį priėmimui iš PHP
        $this->socketServer = stream_socket_server('unix://' . $this->socketPath);
        stream_set_blocking($this->socketServer, 0);
    }
    
    public function onOpen(ConnectionInterface $conn) {
        $this->clients->attach($conn);
        echo "Naujas WebSocket klientas! (" . count($this->clients) . " iš viso)\n";
    }
    
    public function onMessage(ConnectionInterface $from, $msg) {
        // Galima apdoroti žinutes iš kliento
    }
    
    public function onClose(ConnectionInterface $conn) {
        $this->clients->detach($conn);
        echo "Klientas atsijungė. Likę: " . count($this->clients) . "\n";
    }
    
    public function onError(ConnectionInterface $conn, \Exception $e) {
        echo "Klaida: {$e->getMessage()}\n";
        $conn->close();
    }
    
    public function broadcast($message) {
        $jsonMessage = json_encode($message);
        foreach ($this->clients as $client) {
            $client->send($jsonMessage);
        }
    }
    
    public function checkForInternalMessages() {
        if (!$this->socketServer) return;
        
        $client = @stream_socket_accept($this->socketServer, 0);
        if ($client) {
            $data = fgets($client);
            if ($data) {
                $message = json_decode(trim($data), true);
                if ($message) {
                    $this->broadcast($message);
                }
            }
            fclose($client);
        }
    }
    
    public function run() {
        echo "WebSocket serveris paleistas\n";
        echo "Unix socket: {$this->socketPath}\n";
        
        while (true) {
            $this->checkForInternalMessages();
            usleep(10000); // 10ms
        }
    }
}

$server = new WebSocketServer();
$server->run();
?>