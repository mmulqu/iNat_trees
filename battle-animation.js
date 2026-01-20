// battle-animation.js - Handles battle animations for user comparison feature

class BattleAnimator {
  constructor() {
    this.initializeElements();
  }

  initializeElements() {
    // Create the countdown container if it doesn't exist
    if (!document.getElementById('battleCountdown')) {
      const countdownContainer = document.createElement('div');
      countdownContainer.id = 'battleCountdown';
      countdownContainer.className = 'battle-countdown-container';
      countdownContainer.style.display = 'none';

      countdownContainer.innerHTML = `
        <div class="battle-countdown-overlay"></div>
        <div class="battle-countdown-content">
          <div class="battle-countdown-number">3</div>
          <div class="battle-users-container">
            <div class="battle-user left">
              <div class="battle-avatar user1-color"></div>
              <div class="battle-username"></div>
            </div>
            <div class="battle-vs">VS</div>
            <div class="battle-user right">
              <div class="battle-avatar user2-color"></div>
              <div class="battle-username"></div>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(countdownContainer);
    }
  }

  startBattleCountdown(username1, username2, onComplete) {
    console.log(`Starting battle countdown: ${username1} vs ${username2}`);

    // Prepare countdown element
    const countdownContainer = document.getElementById('battleCountdown');
    const countdownNumber = countdownContainer.querySelector('.battle-countdown-number');
    const user1Name = countdownContainer.querySelector('.battle-user.left .battle-username');
    const user2Name = countdownContainer.querySelector('.battle-user.right .battle-username');
    const user1Avatar = countdownContainer.querySelector('.battle-user.left .battle-avatar');
    const user2Avatar = countdownContainer.querySelector('.battle-user.right .battle-avatar');

    // Reset any previous state
    const existingBattleText = countdownContainer.querySelector('.battle-text');
    if (existingBattleText) {
      existingBattleText.remove();
    }
    countdownNumber.style.display = 'block';

    // Set user info
    user1Name.textContent = username1;
    user2Name.textContent = username2;
    user1Avatar.textContent = username1.charAt(0).toUpperCase();
    user2Avatar.textContent = username2.charAt(0).toUpperCase();

    // Show countdown
    countdownContainer.style.display = 'flex';

    // Start countdown
    let count = 3;
    countdownNumber.textContent = count;

    const countdownInterval = setInterval(() => {
      count--;

      if (count > 0) {
        countdownNumber.textContent = count;
      } else if (count === 0) {
        // Show "BATTLE!" text
        countdownNumber.style.display = 'none';

        // Create and show battle text
        const battleText = document.createElement('div');
        battleText.className = 'battle-text';
        battleText.textContent = 'BATTLE!';
        countdownContainer.querySelector('.battle-countdown-content').appendChild(battleText);

        // Start battle text animation
        setTimeout(() => {
          battleText.classList.add('animate-in');
        }, 100);

        // Prepare to hide countdown and animate tree
        setTimeout(() => {
          countdownContainer.style.display = 'none';

          // Call the completion callback
          if (typeof onComplete === 'function') {
            onComplete();
          }
        }, 1500);

        clearInterval(countdownInterval);
      }
    }, 1000);
  }

  animateTree(treeId) {
    console.log(`Animating tree: ${treeId}`);

    const svgContainer = document.getElementById(`${treeId}-svg`);
    if (!svgContainer) {
      console.error(`SVG container not found for tree: ${treeId}`);
      return;
    }

    try {
      // Simplify our approach - animate the whole structure in waves
      // First, get all nodes and paths
      const nodes = svgContainer.querySelectorAll('.markmap-node');
      const links = svgContainer.querySelectorAll('.markmap-link');
      console.log(`Found ${nodes.length} nodes and ${links.length} links to animate`);

      // Initially hide all nodes and links
      nodes.forEach(node => {
        node.style.opacity = '0';
        node.style.transition = 'opacity 0.5s';
      });

      links.forEach(link => {
        link.style.opacity = '0';
        link.style.transition = 'opacity 0.5s';
      });

      // Create a function to reveal nodes level by level
      const revealLevel = (elements, startDelay, increment) => {
        elements.forEach((el, index) => {
          setTimeout(() => {
            el.style.opacity = '1';
          }, startDelay + (index * increment));
        });
      };

      // Find all texts and groups them by their vertical position (rough approximation of levels)
      const textsByLevel = {};
      const linksBySource = {};

      // Group nodes by their y-coordinate (roughly corresponds to tree levels)
      nodes.forEach(node => {
        // Get node position from transform attribute
        const transform = node.getAttribute('transform');
        if (transform) {
          const match = transform.match(/translate\(([^,]+),([^)]+)\)/);
          if (match && match[2]) {
            const y = Math.round(parseFloat(match[2]) / 20) * 20; // Round to nearest 20px to group levels
            if (!textsByLevel[y]) {
              textsByLevel[y] = [];
            }
            textsByLevel[y].push(node);
          } else {
            // If we can't parse the transform, add to level 0
            if (!textsByLevel[0]) {
              textsByLevel[0] = [];
            }
            textsByLevel[0].push(node);
          }
        }
      });

      // Sort levels by y-coordinate (top to bottom)
      const sortedLevels = Object.keys(textsByLevel).sort((a, b) => a - b);

      // Reveal nodes level by level
      sortedLevels.forEach((level, levelIndex) => {
        const nodesInLevel = textsByLevel[level];
        revealLevel(nodesInLevel, 300 + (levelIndex * 200), 50);
      });

      // Reveal links slightly after nodes
      setTimeout(() => {
        revealLevel(Array.from(links), 200, 20);
      }, 300);

      // Add a special effect for comparison trees - color emphasizing
      if (treeId.includes('tree-') && svgContainer.querySelector('.user1-node, .user2-node, .shared-node')) {
        setTimeout(() => {
          // Find nodes with special classes
          const user1Nodes = svgContainer.querySelectorAll('.user1-node-wrapper, .user1-node');
          const user2Nodes = svgContainer.querySelectorAll('.user2-node-wrapper, .user2-node');
          const sharedNodes = svgContainer.querySelectorAll('.shared-node-wrapper, .shared-node');

          // Add highlight effect
          const addHighlight = (nodeList, delay, className) => {
            nodeList.forEach((node, idx) => {
              setTimeout(() => {
                node.classList.add(className + '-highlight');

                // Remove highlight class after a brief flash
                setTimeout(() => {
                  node.classList.remove(className + '-highlight');
                }, 500);
              }, delay + (idx * 30));
            });
          };

          // Add highlights with staggered timing
          addHighlight(user1Nodes, 1000, 'user1-node');
          addHighlight(user2Nodes, 1500, 'user2-node');
          addHighlight(sharedNodes, 2000, 'shared-node');
        }, 1500);
      }
    } catch (error) {
      console.error('Error during tree animation:', error);

      // Fallback - just make everything visible in case of error
      const allElements = svgContainer.querySelectorAll('.markmap-node, .markmap-link');
      allElements.forEach(el => {
        el.style.opacity = '1';
      });
    }
  }
}

// Initialize as a global singleton
window.battleAnimator = new BattleAnimator();