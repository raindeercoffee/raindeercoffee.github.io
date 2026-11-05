// 純裝飾層：只建立一次，不使用計時器，不介入房間、訪客或操作。
const scene = document.getElementById('scene');
if (scene && !scene.querySelector('[data-ambience-stars]')) {
  const stars = document.createElement('div');
  stars.className = 'ambient-stars';
  stars.setAttribute('data-ambience-stars', '');
  stars.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 24; index++) {
    const star = document.createElement('span');
    star.className = 'ambient-star';
    star.style.left = `${8 + (index * 37 % 85)}%`;
    star.style.top = `${10 + (index * 29 % 76)}%`;
    star.style.setProperty('--star-size', `${1.6 + (index * 7 % 8) * .22}px`);
    star.style.setProperty('--star-duration', `${4.2 + (index * 17 % 48) / 10}s`);
    star.style.setProperty('--star-delay', `${-index * .73}s`);
    star.style.setProperty('--star-drift-x', `${index % 2 ? -2 : 3}px`);
    star.style.setProperty('--star-drift-y', `${index % 3 ? -2 : 2}px`);
    stars.append(star);
  }
  scene.prepend(stars);
}
