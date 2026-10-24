/*
 * Pipeline Factory 官网交互：Hero 流水线动画、安装方式 Tab、移动端导航、命令复制、导航高亮。
 * 所有动效都尊重 prefers-reduced-motion；无 JS 时页面内容仍完整可读。
 */

(function () {
  "use strict";

  /* Hero：一次性播放一次 Run 的状态推进。 */
  function initRunPanel() {
    var panel = document.getElementById("product-window");
    if (!panel) return;

    var steps = Array.prototype.slice.call(panel.querySelectorAll("[data-step]"));
    var logs = Array.prototype.slice.call(panel.querySelectorAll("[data-log]"));
    var state = panel.querySelector("[data-run-state]");
    if (!steps.length) return;

    var reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function finish() {
      steps.forEach(function (step) {
        step.classList.remove("is-active");
        step.classList.add("is-done");
      });
      logs.forEach(function (line) {
        line.classList.add("is-on");
      });
      if (state) state.textContent = "MERGE READY";
    }

    if (reduceMotion) {
      finish();
      return;
    }

    panel.classList.add("is-playing");
    var start = 400;
    var gap = 480;

    steps.forEach(function (_, index) {
      window.setTimeout(
        function () {
          steps.forEach(function (step, stepIndex) {
            step.classList.toggle("is-done", stepIndex < index);
            step.classList.toggle("is-active", stepIndex === index);
          });
          logs.forEach(function (line, lineIndex) {
            line.classList.toggle("is-on", index >= 3 + lineIndex);
          });
        },
        start + index * gap,
      );
    });

    window.setTimeout(finish, start + steps.length * gap);
  }

  /* 安装方式 Tab：鼠标点击 + 方向键切换。 */
  function initTabs() {
    document.querySelectorAll("[data-tabs]").forEach(function (group) {
      var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"]'));
      if (!tabs.length) return;

      var panels = tabs.map(function (tab) {
        return document.getElementById(tab.getAttribute("aria-controls"));
      });

      function select(tab) {
        tabs.forEach(function (item) {
          var active = item === tab;
          item.setAttribute("aria-selected", active ? "true" : "false");
          item.tabIndex = active ? 0 : -1;
        });
        panels.forEach(function (panel) {
          if (panel) panel.hidden = panel.id !== tab.getAttribute("aria-controls");
        });
      }

      tabs.forEach(function (tab, index) {
        tab.addEventListener("click", function () {
          select(tab);
        });
        tab.addEventListener("keydown", function (event) {
          var next = null;
          if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
          else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
          else if (event.key === "Home") next = tabs[0];
          else if (event.key === "End") next = tabs[tabs.length - 1];
          if (!next) return;
          event.preventDefault();
          next.focus();
          select(next);
        });
      });
    });
  }

  /* 移动端导航。 */
  function initNav() {
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.getElementById("site-nav");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > 940) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* 复制安装命令。 */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        if (document.execCommand("copy")) {
          resolve();
        } else {
          reject(new Error("copy failed"));
        }
      } catch (error) {
        reject(error);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  function initCopyButtons() {
    document.querySelectorAll("[data-copy-target]").forEach(function (button) {
      button.addEventListener("click", function () {
        var target = document.getElementById(button.getAttribute("data-copy-target"));
        if (!target) return;
        copyText(target.innerText)
          .then(function () {
            var label = button.textContent;
            button.textContent = "已复制";
            button.classList.add("is-copied");
            window.setTimeout(function () {
              button.textContent = label;
              button.classList.remove("is-copied");
            }, 1600);
          })
          .catch(function () {
            button.textContent = "复制失败";
            window.setTimeout(function () {
              button.textContent = "复制";
            }, 1600);
          });
      });
    });
  }

  /* 当前区块对应的导航项：按滚动位置取最后一个越过阅读线的区块。 */
  function initActiveNav() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.site-nav a[href^="#"]'));
    if (!links.length) return;

    var linkFor = {};
    links.forEach(function (link) {
      linkFor[link.getAttribute("href").slice(1)] = link;
    });

    var sections = Object.keys(linkFor)
      .map(function (id) {
        return document.getElementById(id);
      })
      .filter(Boolean);
    if (!sections.length) return;

    var ticking = false;

    function update() {
      ticking = false;
      var line = window.scrollY + 140;
      var current = sections[0];
      sections.forEach(function (section) {
        if (section.offsetTop <= line) current = section;
      });
      links.forEach(function (link) {
        link.classList.toggle("is-current", link === linkFor[current.id]);
      });
    }

    function requestUpdate() {
      if (ticking) return;
      ticking = true;
      window.setTimeout(function () {
        update();
      }, 80);
    }

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    update();
  }

  function initYear() {
    var year = document.getElementById("year");
    if (year) year.textContent = String(new Date().getFullYear());
  }

  initRunPanel();
  initTabs();
  initNav();
  initCopyButtons();
  initActiveNav();
  initYear();
})();
