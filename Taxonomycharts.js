// TaxonomyCharts.js - Visualization charts for taxonomy statistics

class TaxonomyCharts {
  constructor() {
    this.initializeStyles();
  }

  initializeStyles() {
    if (!document.getElementById('taxonomy-charts-styles')) {
      const style = document.createElement('style');
      style.id = 'taxonomy-charts-styles';
      style.textContent = `
        .taxonomy-chart-container {
          margin: 20px 0;
          padding: 15px;
          background-color: white;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .taxonomy-chart-title {
          font-weight: bold;
          color: #333;
          margin-bottom: 15px;
          text-align: center;
        }
        .chart-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          gap: 20px;
        }
        .chart-card {
          background-color: white;
          border-radius: 8px;
          padding: 15px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.05);
          height: 300px;
          position: relative;
        }
        .chart-legend {
          display: flex;
          justify-content: center;
          gap: 15px;
          margin-top: 10px;
          flex-wrap: wrap;
        }
        .legend-item {
          display: flex;
          align-items: center;
          font-size: 0.9rem;
        }
        .legend-color {
          width: 12px;
          height: 12px;
          border-radius: 3px;
          margin-right: 5px;
        }
        .comparison-chart-container .taxonomy-chart-title {
          margin-bottom: 5px;
        }
        .comparison-subtitle {
          text-align: center;
          color: #666;
          font-size: 0.9rem;
          margin-bottom: 15px;
        }
        .taxonomy-rank-bar {
          height: 30px;
          margin: 8px 0;
          background-color: #f5f5f5;
          border-radius: 4px;
          overflow: hidden;
          display: flex;
        }
        .taxonomy-rank-label {
          width: 80px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          font-weight: bold;
          background-color: rgba(0,0,0,0.05);
        }
        .taxonomy-rank-bar-inner {
          display: flex;
          align-items: center;
          padding: 0 10px;
          color: white;
          font-weight: bold;
          transition: width 0.5s ease;
        }
        .user1-bar {
          background-color: #ff6b6b;
        }
        .user2-bar {
          background-color: #4dabf7;
        }
        .canvas-container {
          width: 100%;
          height: 250px;
        }
      `;
      document.head.appendChild(style);
    }
  }

  // Create a bar chart visualization of taxonomic ranks
  createTaxonomyBarChart(stats, title) {
    const container = document.createElement('div');
    container.className = 'taxonomy-chart-container';

    const titleEl = document.createElement('div');
    titleEl.className = 'taxonomy-chart-title';
    titleEl.textContent = title || 'Taxonomic Diversity';
    container.appendChild(titleEl);

    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 250;

    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'canvas-container';
    canvasContainer.appendChild(canvas);
    container.appendChild(canvasContainer);

    // Use setTimeout to ensure the canvas is in the DOM before drawing
    setTimeout(() => {
      const ctx = canvas.getContext('2d');

      // Extract data for the chart
      const labels = ['Species', 'Genera', 'Families', 'Orders', 'Classes', 'Phyla'];
      const data = [
        stats.species || 0,
        stats.genera || 0, 
        stats.families || 0,
        stats.orders || 0,
        stats.classes || 0,
        stats.phyla || 0
      ];

      // Create gradient for bars
      const gradient = ctx.createLinearGradient(0, 0, 0, 250);
      gradient.addColorStop(0, '#3fac8c');
      gradient.addColorStop(1, '#2d7d64');

      // Draw the chart
      new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: 'Count',
            data: data,
            backgroundColor: gradient,
            borderColor: '#2d7d64',
            borderWidth: 1,
            borderRadius: 4,
            barThickness: 40
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  return `Count: ${context.raw}`;
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              grid: {
                color: 'rgba(0, 0, 0, 0.05)'
              },
              ticks: {
                precision: 0
              }
            },
            x: {
              grid: {
                display: false
              }
            }
          }
        }
      });
    }, 100);

    return container;
  }

  // Create a pie chart showing taxonomic composition
  createTaxonomicCompositionChart(stats, title) {
    const container = document.createElement('div');
    container.className = 'taxonomy-chart-container';

    const titleEl = document.createElement('div');