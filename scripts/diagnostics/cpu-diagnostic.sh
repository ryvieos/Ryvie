#!/bin/bash

# Script de diagnostic CPU sur 1 minute
# Analyse les processus qui consomment le plus de CPU

echo "🔍 Diagnostic CPU - Analyse sur 1 minute"
echo "=========================================="
echo ""

# Fonction pour afficher le top des processus
show_top_processes() {
    echo "📊 Top 10 des processus par CPU:"
    ps aux --sort=-%cpu | head -11 | awk '{printf "%-8s %-6s %-6s %-10s %s\n", $1, $2, $3, $4, $11}'
    echo ""
}

# Fonction pour analyser les conteneurs Docker
show_docker_stats() {
    if command -v docker &> /dev/null; then
        echo "🐳 Statistiques Docker (si des conteneurs tournent):"
        docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" 2>/dev/null || echo "Aucun conteneur en cours d'exécution"
        echo ""
    fi
}

# Fonction pour analyser Node.js
show_node_processes() {
    echo "📦 Processus Node.js actifs:"
    ps aux | grep -E '[n]ode|[n]pm' | awk '{printf "PID: %-6s CPU: %-6s MEM: %-6s CMD: %s\n", $2, $3, $4, substr($0, index($0,$11))}'
    echo ""
}

# Fonction pour analyser les services système
show_system_services() {
    echo "⚙️  Services système principaux:"
    for service in caddy nginx apache2 mysql postgresql redis; do
        if pgrep -x "$service" > /dev/null; then
            ps aux | grep -E "[${service:0:1}]${service:1}" | awk '{printf "%-10s PID: %-6s CPU: %-6s MEM: %-6s\n", "'$service'", $2, $3, $4}'
        fi
    done
    echo ""
}

# Snapshot initial
echo "⏱️  Snapshot initial (T=0s)"
echo "----------------------------"
show_top_processes
show_docker_stats
show_node_processes
show_system_services

# Collecter des données toutes les 10 secondes
for i in {1..6}; do
    echo "⏱️  Snapshot $i/6 (T=${i}0s)"
    echo "----------------------------"
    sleep 10
    show_top_processes
done

# Analyse finale
echo ""
echo "📈 Analyse finale - Moyennes sur 1 minute"
echo "=========================================="
echo ""

# Top 5 des processus par utilisation CPU moyenne
echo "🔥 Top 5 des processus les plus gourmands:"
ps aux --sort=-%cpu | head -6 | tail -5 | awk '{printf "%-20s CPU: %-6s MEM: %-6s PID: %-6s\n", $11, $3"%", $4"%", $2}'
echo ""

# Utilisation globale du système
echo "💻 Utilisation globale du système:"
top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print "CPU utilisé: " 100 - $1 "%"}'
free -h | awk '/^Mem:/ {printf "RAM utilisée: %s / %s (%.1f%%)\n", $3, $2, ($3/$2)*100}'
echo ""

# Processus suspects (>5% CPU en idle)
echo "⚠️  Processus suspects (>5% CPU):"
ps aux --sort=-%cpu | awk '$3 > 5.0 {printf "%-20s CPU: %-6s PID: %-6s\n", $11, $3"%", $2}' | head -10
echo ""

echo "✅ Diagnostic terminé"
echo ""
echo "💡 Recommandations:"
echo "   - Si Node.js consomme beaucoup: vérifier les websockets et les timers"
echo "   - Si Caddy/Nginx consomme: vérifier les logs et les connexions actives"
echo "   - Si Docker consomme: vérifier les conteneurs avec 'docker stats'"
echo "   - Utiliser 'htop' pour un monitoring en temps réel"
