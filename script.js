/* ═══════════════════════════════════════════
   DEV PATEL PORTFOLIO — INTERACTIONS
   ═══════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

    // ── LOADER ──
    const loader = document.getElementById('loader');
    setTimeout(() => {
        loader.classList.add('hidden');
        document.body.style.overflow = 'auto';
        triggerHeroAnimations();
    }, 1800);

    // ── CUSTOM CURSOR ──
    const cursor = document.getElementById('cursor');
    const follower = document.getElementById('cursorFollower');
    let mouseX = 0, mouseY = 0;
    let cursorX = 0, cursorY = 0;
    let followerX = 0, followerY = 0;

    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    function animateCursor() {
        followerX += (mouseX - followerX) * 0.08;
        followerY += (mouseY - followerY) * 0.08;

        if (cursor) {
            cursor.style.left = mouseX + 'px';
            cursor.style.top = mouseY + 'px';
        }
        if (follower) {
            follower.style.left = followerX + 'px';
            follower.style.top = followerY + 'px';
        }
        requestAnimationFrame(animateCursor);
    }
    animateCursor();

    // Cursor hover effects
    const hoverables = document.querySelectorAll('a, button, .service-card, .skill-card, .trait, .case-image');
    hoverables.forEach(el => {
        el.addEventListener('mouseenter', () => {
            cursor?.classList.add('hovering');
            follower?.classList.add('hovering');
        });
        el.addEventListener('mouseleave', () => {
            cursor?.classList.remove('hovering');
            follower?.classList.remove('hovering');
        });
    });


    // ── NAVBAR SCROLL ──
    const navbar = document.getElementById('navbar');

    // ── MOBILE MENU ──
    const hamburger = document.getElementById('hamburger');
    const mobileMenu = document.getElementById('mobileMenu');
    const mobileLinks = document.querySelectorAll('.mobile-link');

    hamburger?.addEventListener('click', () => {
        hamburger.classList.toggle('active');
        mobileMenu?.classList.toggle('active');
        document.body.style.overflow = mobileMenu?.classList.contains('active') ? 'hidden' : 'auto';
    });

    mobileLinks.forEach(link => {
        link.addEventListener('click', () => {
            hamburger?.classList.remove('active');
            mobileMenu?.classList.remove('active');
            document.body.style.overflow = 'auto';
        });
    });

    // ── SMOOTH SCROLL ──
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', (e) => {
            e.preventDefault();
            const target = document.querySelector(anchor.getAttribute('href'));
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });

    // ── REVEAL ON SCROLL (Intersection Observer) ──
    const revealElements = document.querySelectorAll('.reveal-up');

    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                revealObserver.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    // Don't observe hero elements — they'll be triggered by the loader
    revealElements.forEach(el => {
        if (!el.closest('#hero')) {
            revealObserver.observe(el);
        }
    });

    // ── HERO ANIMATIONS (triggered after loader) ──
    function triggerHeroAnimations() {
        const heroElements = document.querySelectorAll('#hero .reveal-up');
        heroElements.forEach((el, i) => {
            setTimeout(() => {
                el.classList.add('visible');
            }, i * 120);
        });

        // Start typewriter after hero fades in
        setTimeout(startTypewriter, 1400);
    }

    // ── TYPEWRITER ──
    const typewriterEl = document.getElementById('typewriter-text');
    const typewriterPhrases = [
        'I build the change.',
        'I ship things that matter.',
        'I turn ideas into products.',
        'I move fast. I move smart.'
    ];
    let twPhrase = 0;
    let twChar = 0;
    let twDeleting = false;
    let twTimer = null;
    const TW_SPEED_TYPE = 60;
    const TW_SPEED_DELETE = 35;
    const TW_PAUSE = 2400;

    function startTypewriter() {
        if (!typewriterEl) return;
        // Skip on reduced motion
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        tickTypewriter();
    }

    function tickTypewriter() {
        const current = typewriterPhrases[twPhrase];
        if (twDeleting) {
            twChar--;
            typewriterEl.textContent = current.slice(0, twChar);
            if (twChar === 0) {
                twDeleting = false;
                twPhrase = (twPhrase + 1) % typewriterPhrases.length;
                twTimer = setTimeout(tickTypewriter, 300);
            } else {
                twTimer = setTimeout(tickTypewriter, TW_SPEED_DELETE);
            }
        } else {
            twChar++;
            typewriterEl.textContent = current.slice(0, twChar);
            if (twChar === current.length) {
                twTimer = setTimeout(() => { twDeleting = true; tickTypewriter(); }, TW_PAUSE);
            } else {
                twTimer = setTimeout(tickTypewriter, TW_SPEED_TYPE);
            }
        }
    }

    // ── STAT COUNTER ANIMATION ──
    const statNumbers = document.querySelectorAll('.stat-number[data-target]');

    const counterObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                const target = parseInt(el.getAttribute('data-target'));
                animateCounter(el, target);
                counterObserver.unobserve(el);
            }
        });
    }, { threshold: 0.5 });

    statNumbers.forEach(stat => counterObserver.observe(stat));

    function animateCounter(el, target) {
        const duration = 1500;
        const start = performance.now();
        const startVal = 0;

        function update(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.floor(startVal + (target - startVal) * eased);
            el.textContent = current;

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                el.textContent = target;
            }
        }
        requestAnimationFrame(update);
    }

    // ── SKILL BARS ANIMATION ──
    const skillFills = document.querySelectorAll('.skill-fill');

    // Stamp data-pct so the CSS ::after pseudo-element can display it
    skillFills.forEach(fill => {
        const w = fill.getAttribute('data-width');
        if (w) fill.setAttribute('data-pct', w + '%');
    });

    const skillObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                const width = el.getAttribute('data-width');
                el.style.setProperty('--target-width', width + '%');
                el.classList.add('active');
                skillObserver.unobserve(el);
            }
        });
    }, { threshold: 0.5 });

    skillFills.forEach(fill => skillObserver.observe(fill));

    // ── TIMELINE LINE DRAW ──
    const timeline = document.querySelector('.timeline');
    if (timeline) {
        const lines = timeline.querySelectorAll('.marker-line');
        lines.forEach((line, i) => {
            line.style.setProperty('--line-delay', (i * 0.18) + 's');
        });
        const timelineObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    timeline.classList.add('in-view');
                    timelineObserver.unobserve(timeline);
                }
            });
        }, { threshold: 0.15 });
        timelineObserver.observe(timeline);
    }

    // ── ACTIVE NAV LINK ON SCROLL ──
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.nav-link');

    // ── SCROLL TO TOP ──
    const scrollTopBtn = document.getElementById('scrollToTop');

    window.addEventListener('scroll', () => {
        // Navbar
        if (window.scrollY > 80) {
            navbar?.classList.add('scrolled');
        } else {
            navbar?.classList.remove('scrolled');
        }

        // Scroll-to-top visibility
        if (scrollTopBtn) {
            if (window.scrollY > 500) {
                scrollTopBtn.classList.add('visible');
            } else {
                scrollTopBtn.classList.remove('visible');
            }
        }

        // Active nav link
        let current = '';
        sections.forEach(section => {
            const top = section.offsetTop - 200;
            if (window.scrollY >= top) {
                current = section.getAttribute('id');
            }
        });
        navLinks.forEach(link => {
            link.style.color = '';
            if (link.getAttribute('href') === '#' + current) {
                link.style.color = 'var(--accent)';
            }
        });
    });

    scrollTopBtn?.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Also add scroll-to-top to cursor hoverables
    if (scrollTopBtn) {
        scrollTopBtn.addEventListener('mouseenter', () => {
            cursor?.classList.add('hovering');
            follower?.classList.add('hovering');
        });
        scrollTopBtn.addEventListener('mouseleave', () => {
            cursor?.classList.remove('hovering');
            follower?.classList.remove('hovering');
        });
    }

    // ── CONTACT FORM ──
    const form = document.getElementById('contactForm');
    form?.addEventListener('submit', (e) => {
        e.preventDefault();

        const btn = form.querySelector('button[type="submit"]');
        const originalText = btn.innerHTML;
        btn.innerHTML = 'SENDING...';
        btn.disabled = true;

        const data = new FormData(form);
        const jsonData = {};
        data.forEach((value, key) => jsonData[key] = value);
        jsonData['_captcha'] = false;
        jsonData['_subject'] = 'New Inquiry via devpatel.in Portfolio';

        fetch(form.action, {
            method: 'POST',
            body: JSON.stringify(jsonData),
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        })
        .then(response => {
            if (response.ok) {
                btn.innerHTML = 'SENT ✓';
                btn.style.background = '#22c55e';
                form.reset();
            } else {
                btn.innerHTML = 'FAILED ✗';
                btn.style.background = '#ef4444';
            }
        })
        .catch(() => {
            btn.innerHTML = 'FAILED ✗';
            btn.style.background = '#ef4444';
        })
        .finally(() => {
            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.style.background = '';
                btn.disabled = false;
            }, 2500);
        });
    });



    // ── TILT EFFECT ON SERVICE CARDS ──
    const cards = document.querySelectorAll('.service-card, .skill-card');
    cards.forEach(card => {
        card.addEventListener('mousemove', (e) => {
            if (window.innerWidth <= 768) return;
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            const rotateX = (y - centerY) / 20;
            const rotateY = (centerX - x) / 20;
            card.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-4px)`;
        });

        card.addEventListener('mouseleave', () => {
            card.style.transform = '';
        });
    });

    // ── MOMENTS CAROUSEL ──
    const carousel = document.getElementById('momentsCarousel');
    const slides = document.querySelectorAll('.carousel-slide');
    const dots = document.querySelectorAll('.carousel-dot');
    const prevBtn = document.getElementById('carouselPrev');
    const nextBtn = document.getElementById('carouselNext');
    let currentSlide = 0;
    let autoPlayInterval = null;
    const totalSlides = slides.length;
    const AUTO_PLAY_DELAY = 2500;

    function goToSlide(index) {
        slides[currentSlide].classList.remove('active');
        dots[currentSlide].classList.remove('active');
        currentSlide = (index + totalSlides) % totalSlides;
        slides[currentSlide].classList.add('active');
        dots[currentSlide].classList.add('active');
    }

    function nextSlide() {
        goToSlide(currentSlide + 1);
    }

    function prevSlide() {
        goToSlide(currentSlide - 1);
    }

    function startAutoPlay() {
        stopAutoPlay();
        autoPlayInterval = setInterval(nextSlide, AUTO_PLAY_DELAY);
    }

    function stopAutoPlay() {
        if (autoPlayInterval) {
            clearInterval(autoPlayInterval);
            autoPlayInterval = null;
        }
    }

    if (carousel && totalSlides > 0) {
        // Arrow clicks
        prevBtn?.addEventListener('click', () => {
            prevSlide();
            startAutoPlay(); // Reset timer after manual nav
        });

        nextBtn?.addEventListener('click', () => {
            nextSlide();
            startAutoPlay();
        });

        // Dot clicks
        dots.forEach(dot => {
            dot.addEventListener('click', () => {
                const index = parseInt(dot.getAttribute('data-index'));
                goToSlide(index);
                startAutoPlay();
            });
        });

        // Pause on hover
        carousel.addEventListener('mouseenter', stopAutoPlay);
        carousel.addEventListener('mouseleave', startAutoPlay);

        // Touch swipe support
        let touchStartX = 0;
        let touchEndX = 0;

        carousel.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
            stopAutoPlay();
        }, { passive: true });

        carousel.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            const diff = touchStartX - touchEndX;
            if (Math.abs(diff) > 50) {
                if (diff > 0) nextSlide();
                else prevSlide();
            }
            startAutoPlay();
        }, { passive: true });

        // Start auto-play when section is visible
        const carouselObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    startAutoPlay();
                } else {
                    stopAutoPlay();
                }
            });
        }, { threshold: 0.3 });

        carouselObserver.observe(carousel);
    }

});
