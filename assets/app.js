const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = (url, options = {}) =>
  fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.error || "Não foi possível concluir.");
    return data;
  });
const token = () => localStorage.getItem("hairstyles-token");
const getErrorMessage = (error, fallback = "Não foi possível concluir a operação.") => {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return fallback;
};
const feedback = (element, message, type = "error") => {
  if (!element) return;
  element.textContent = message;
  element.dataset.type = type;
};
const lockSubmit = (form, locked) => {
  const button = $('button[type="submit"]', form);
  if (button) {
    if (!button.dataset.label) button.dataset.label = button.textContent.trim();
    button.disabled = locked;
    button.classList.toggle("is-loading", locked);
    button.textContent = locked
      ? "Aguarde..."
      : button.dataset.label;
  }
};

function updateAuthLinks() {
  const link = $("[data-auth-link]");
  if (link && token()) {
    link.textContent = "Meu perfil";
    link.href = "/perfil.html";
  }
  const profile = $("[data-profile-link]");
  if (profile && !token()) profile.href = "/login.html";
}
function setupGlobalFooter() {
  if (document.querySelector(".site-footer")) return;
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `
    <div><a class="brand" href="/index.html">Hairstyles<span>studio</span></a><p>beleza com intenção</p></div>
    <div><p class="footer-kicker">Fale Conosco</p><a href="mailto:oi@hairstyles.example">oi@hairstyles.example</a><a href="tel:+5511999990000">(11) 99999-0000</a><span>CNPJ 12.345.678/0001-90</span></div>`;
  document.body.append(footer);
}
function money(cents) {
  return cents == null
    ? ""
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(cents / 100);
}
function applyMasks() {
  $$("[data-mask]").forEach((input) =>
    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "");
      if (input.dataset.mask === "cpf")
        input.value = digits
          .replace(/(\d{3})(\d)/, "$1.$2")
          .replace(/(\d{3})(\d)/, "$1.$2")
          .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
      if (input.dataset.mask === "phone")
        input.value = digits
          .replace(/(\d{2})(\d)/, "($1) $2")
          .replace(/(\d{5})(\d)/, "$1-$2")
          .slice(0, 15);
      if (input.dataset.mask === "cep")
        input.value = digits.replace(/(\d{5})(\d)/, "$1-$2").slice(0, 9);
    }),
  );
  const cep = $('[name="cep"]');
  if (cep)
    cep.addEventListener("blur", async () => {
      if (cep.value.replace(/\D/g, "").length !== 8) return;
      try {
        const address = await fetch(
          `https://viacep.com.br/ws/${cep.value.replace(/\D/g, "")}/json/`,
        ).then((r) => r.json());
        if (address.erro) return;
        $('[name="street"]').value = address.logradouro || "";
        $('[name="neighborhood"]').value = address.bairro || "";
        $('[name="city"]').value = address.localidade || "";
        $('[name="state"]').value = address.uf || "";
      } catch {}
    });
}

async function loadPopular() {
  const target = $("#popular-services");
  if (!target) return;
  try {
    const { services } = await api("/api/services/popular");
    target.innerHTML = services
      .map(
        (service, index) =>
          `<article class="feed-card"><div class="image-placeholder">Imagem inserida posteriormente</div><div class="feed-meta"><span>0${index + 1}</span><h3>${service.name}</h3><p>${service.description}</p><strong>${service.price_note}</strong></div></article>`,
      )
      .join("");
  } catch (error) {
    const message = getErrorMessage(error, "Erro ao carregar serviços populares.");
    target.innerHTML = `<p class="error-box">Erro ao carregar serviços populares: ${message}</p>`;
  }
}

async function setupBooking() {
  const app = $("#booking-app");
  if (!app) return;
  if (!token()) {
    app.innerHTML =
      '<div class="notice">Entre na sua conta para escolher um horário. <a href="/login.html">Entrar agora</a></div>';
    return;
  }
  let services;
  try {
    services = (await api("/api/services")).services;
  } catch (error) {
    const message = getErrorMessage(error, "Erro ao carregar a agenda.");
    app.innerHTML = `<div class="error-box">Erro ao carregar a agenda: ${message}</div>`;
    return;
  }
  let selectedServices = [];
  let selectedSlot = null;
  let currentStep = 1;
  app.innerHTML = `
    <div class="booking-step" data-step="1">
      <p class="step-kicker">Etapa 1 de 3</p>
      <h2>Monte seu cuidado</h2>
      <p class="muted">Selecione um ou mais serviços para o mesmo atendimento.</p>
      <div class="service-grid">${services.map((service) => `<button type="button" class="service-option" data-id="${service.id}"><span class="square-placeholder">01</span><span><b>${service.name}</b><small>${service.description}</small><strong>${service.price_note}</strong></span></button>`).join("")}</div>
      <div class="wizard-actions"><span></span><button type="button" class="button" id="booking-next-services">Avançar para horário</button></div>
    </div>
    <div class="booking-step hidden" data-step="2">
      <p class="step-kicker">Etapa 2 de 3</p>
      <h2>Escolha seu horário</h2>
      <label>Escolha uma data<input id="date-picker" type="date" min="${new Date().toISOString().slice(0, 10)}"></label>
      <div id="slots" class="slots"></div>
      <div class="wizard-actions"><button type="button" class="button secondary" data-booking-back>Voltar</button><button type="button" class="button" id="booking-next-time" disabled>Avançar para confirmação</button></div>
    </div>
    <div class="booking-step hidden" data-step="3">
      <p class="step-kicker">Etapa 3 de 3</p>
      <h2>Confirme seu atendimento</h2>
      <div id="booking-summary" class="booking-summary"></div>
      <div class="disclaimers"><p>Todos os serviços de química deverão passar por diagnóstico capilar (teste de mechas), assim como outros tratamentos de acordo com a necessidade do cabelo.</p><p>Valores sujeitos a alterações de acordo com a necessidade do serviço.</p></div>
      <div class="wizard-actions"><button type="button" class="button secondary" data-booking-back>Voltar</button><button type="button" id="confirm-booking" class="button">Confirmar agendamento</button></div>
    </div>
    <p class="form-feedback" id="booking-feedback" role="status"></p>`;
  const updateSteps = () => {
    $$(".steps span").forEach((step, index) =>
      step.classList.toggle("current", index + 1 === currentStep),
    );
    $$(".booking-step", app).forEach((step) =>
      step.classList.toggle("hidden", Number(step.dataset.step) !== currentStep),
    );
  };
  const showError = (message) => feedback($("#booking-feedback", app), message);
  const selectedServiceData = () =>
    services.filter((service) => selectedServices.includes(service.id));
  const renderSummary = () => {
    const chosen = selectedServiceData();
    const total = chosen.reduce((sum, service) => sum + (service.price_cents || 0), 0);
    $("#booking-summary", app).innerHTML = `<p><strong>Serviços</strong><br>${chosen.map((service) => service.name).join(" + ")}</p><p><strong>Horário</strong><br>${$("#date-picker", app).value} às ${$(".slot.selected", app)?.textContent || ""}</p><p><strong>Total estimado</strong><br>${money(total)}</p>`;
  };
  $$(".service-option", app).forEach((button) =>
    button.addEventListener("click", () => {
      const serviceId = button.dataset.id;
      selectedServices = selectedServices.includes(serviceId)
        ? selectedServices.filter((id) => id !== serviceId)
        : [...selectedServices, serviceId];
      button.classList.add("selected");
      button.classList.toggle("selected", selectedServices.includes(serviceId));
    }),
  );
  $("#booking-next-services", app).addEventListener("click", () => {
    if (!selectedServices.length)
      return showError("Selecione pelo menos um serviço para avançar.");
    feedback($("#booking-feedback", app), "");
    currentStep = 2;
    updateSteps();
  });
  $("#date-picker").addEventListener("change", async (event) => {
    selectedSlot = null;
    $("#booking-next-time").disabled = true;
    $("#slots").innerHTML = '<span class="loading">Buscando horários...</span>';
    try {
      const { slots } = await api(
        `/api/availability?date=${event.target.value}`,
      );
      $("#slots").innerHTML = slots.length
        ? slots
            .map(
              (slot) =>
                `<button class="slot" data-id="${slot.id}">${slot.time}</button>`,
            )
            .join("")
        : '<span class="muted">Nenhum horário disponível nesta data.</span>';
      $$(".slot").forEach((slot) =>
        slot.addEventListener("click", () => {
          $$(".slot").forEach((item) => item.classList.remove("selected"));
          slot.classList.add("selected");
          selectedSlot = slot.dataset.id;
          $("#booking-next-time").disabled = false;
        }),
      );
    } catch (error) {
      const message = getErrorMessage(error, "Erro ao buscar horários.");
      $("#slots").innerHTML = `<span class="error-box">Erro ao buscar horários: ${message}</span>`;
    }
  });
  $("#booking-next-time", app).addEventListener("click", () => {
    if (!selectedSlot) return showError("Escolha um horário para continuar.");
    renderSummary();
    feedback($("#booking-feedback", app), "");
    currentStep = 3;
    updateSteps();
  });
  $$('[data-booking-back]', app).forEach((button) =>
    button.addEventListener("click", () => {
      currentStep = Math.max(1, currentStep - 1);
      updateSteps();
    }),
  );
  $("#confirm-booking").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Confirmando...";
    try {
      await api("/api/bookings", {
        method: "POST",
        headers: { Authorization: `Bearer ${token()}` },
        body: JSON.stringify({
          serviceIds: selectedServices,
          slotId: selectedSlot,
        }),
      });
      feedback(
        $("#booking-feedback"),
        "Agendamento confirmado. Até breve!",
        "success",
      );
      button.textContent = "Agendamento confirmado";
      button.disabled = true;
    } catch (error) {
      const message = getErrorMessage(error, "Erro ao confirmar agendamento.");
      feedback($("#booking-feedback"), `Erro ao confirmar agendamento: ${message}`);
      button.disabled = false;
      button.textContent = "Confirmar agendamento";
    }
  });
  updateSteps();
}

async function setupHistory() {
  const app = $("#history-app");
  if (!app) return;
  if (!token()) {
    app.innerHTML =
      '<div class="notice">Entre na sua conta para consultar seus agendamentos. <a href="/login.html">Entrar agora</a></div>';
    return;
  }

  try {
    const history = await api("/api/bookings/history", {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const upcoming = Array.isArray(history?.upcoming) ? history.upcoming : [];
    const completed = Array.isArray(history?.completed) ? history.completed : [];
    const renderBooking = (booking) => {
      const services = Array.isArray(booking?.services) ? booking.services : [];
      const serviceNames = services.length
        ? services.map((service) => service.name).join(" + ")
        : "Serviço do agendamento";
      return `<article class="history-card"><div><span class="history-date">${booking.date} · ${booking.time}</span><h3>${serviceNames}</h3></div><strong>${money(booking.total_cents)}</strong></article>`;
    };
    const renderGroup = (title, items, emptyMessage) => `
      <section class="history-group">
        <div class="section-heading"><div><p class="eyebrow">${items.length ? `${items.length} registro(s)` : "Nada por aqui"}</p><h2>${title}</h2></div></div>
        ${items.length ? `<div class="history-list">${items.map(renderBooking).join("")}</div>` : `<div class="notice">${emptyMessage}</div>`}
      </section>`;
    app.innerHTML =
      renderGroup("Agendamentos vigentes", upcoming, "Você ainda não tem atendimentos futuros.") +
      renderGroup("Serviços realizados", completed, "Seus atendimentos concluídos aparecerão aqui.");
  } catch (error) {
    const message = getErrorMessage(error, "Erro ao carregar histórico.");
    app.innerHTML = `<div class="error-box">Erro ao carregar histórico: ${message}</div>`;
  }
}

function setupForms() {
  const login = $("#login-form");
  if (login)
    login.addEventListener("submit", async (event) => {
      event.preventDefault();
      lockSubmit(login, true);
      const status = $(".form-feedback", login);
      try {
        const data = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(login))),
        });
        localStorage.setItem("hairstyles-token", data.token);
        location.href = "/perfil.html";
      } catch (error) {
        const message = getErrorMessage(error, "Erro ao fazer login.");
        feedback(status, `Erro ao fazer login: ${message}`);
        lockSubmit(login, false);
      }
    });
  const register = $("#register-form");
  if (register)
    register.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = Object.fromEntries(new FormData(register));
      const status = $(".form-feedback", register);
      if (formData.password !== formData.confirmPassword)
        return feedback(status, "As senhas precisam ser iguais.");
      lockSubmit(register, true);
      try {
        await api("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            ...formData,
            address: {
              cep: formData.cep,
              street: formData.street,
              number: formData.number,
              complement: formData.complement,
              neighborhood: formData.neighborhood,
              city: formData.city,
              state: formData.state,
            },
          }),
        });
        feedback(status, "Cadastro criado. Você já pode entrar.", "success");
        lockSubmit(register, false);
        setTimeout(() => {
          location.href = "/login.html";
        }, 900);
      } catch (error) {
        const message = getErrorMessage(error, "Erro ao criar cadastro.");
        feedback(status, `Erro ao criar cadastro: ${message}`);
        lockSubmit(register, false);
      }
    });
}

function setupRecoverForm() {
  const form = document.getElementById("recover-form");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = form.email.value.trim();
    const status = document.getElementById("recover-feedback");

    if (!email) {
      feedback(status, "Informe seu e-mail para continuar.");
      return;
    }

    lockSubmit(form, true);

    try {
      const data = await api("/api/auth/recover", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      feedback(status, data.message, "success");
      form.reset();
    } catch (error) {
      const message = getErrorMessage(error, "Erro ao enviar solicitação de recuperação.");
      feedback(status, `Erro ao enviar solicitação de recuperação: ${message}`);
    } finally {
      lockSubmit(form, false);
    }
  });
}

function setupResetForm() {
  const form = document.getElementById("reset-form");
  if (!form) return;
  const status = document.getElementById("reset-feedback");
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const accessToken = params.get("access_token");
  if (!accessToken) {
    feedback(
      status,
      params.get("error_description") ||
        "Link inválido ou expirado. Solicite uma nova recuperação de senha.",
    );
    $('button[type="submit"]', form).disabled = true;
    return;
  }
  history.replaceState(null, "", location.pathname); // tira o token da barra de endereço

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.password.value !== form.confirmPassword.value)
      return feedback(status, "As senhas precisam ser iguais.");
    lockSubmit(form, true);
    try {
      const data = await api("/api/auth/reset", {
        method: "POST",
        body: JSON.stringify({ accessToken, password: form.password.value }),
      });
      feedback(status, data.message, "success");
      setTimeout(() => {
        location.href = "/login.html";
      }, 1200);
    } catch (error) {
      const message = getErrorMessage(error, "Erro ao redefinir a senha.");
      feedback(status, `Erro ao redefinir a senha: ${message}`);
      lockSubmit(form, false);
    }
  });
}

function setupLegalModal() {
  const modal = document.getElementById("legal-modal");
  if (!modal) return;

  const title = document.getElementById("legal-title");
  const content = document.getElementById("legal-content");
  const closeButton = document.getElementById("legal-close");

  const policies = {
    terms: {
      title: "Termos e condições de uso",
      body: `
        <p>Ao usar nossos serviços, o usuário concorda com as regras de acesso, agendamento e uso da plataforma da Hairstyles.</p>
        <h3>Dados coletados e finalidade</h3>
        <ul>
          <li>Nome completo, e-mail, telefone, data de nascimento e CPF para identificação, contato e confirmação de agendamento.</li>
          <li>Endereço e dados complementares para logística, emissão de documentos e atendimento personalizado.</li>
          <li>Informações de agendamento, serviços solicitados e preferências de cuidado para organizar a experiência do cliente.</li>
        </ul>
        <h3>Base legal</h3>
        <ul>
          <li>Consentimento livre, informado e específico para cadastro e uso de dados pessoais.</li>
          <li>Execução de contrato quando houver prestação de serviços de beleza e agendamento.</li>
          <li>Legítimo interesse para proteção de contas, prevenção de fraudes e melhora do atendimento.</li>
        </ul>
        <h3>Direitos dos titulares</h3>
        <ul>
          <li>Solicitar acesso aos dados pessoais tratados pela plataforma.</li>
          <li>Solicitar retificação de informações incorretas ou incompletas.</li>
          <li>Solicitar exclusão dos dados, quando não houver necessidade legal para manutenção.</li>
          <li>Solicitar portabilidade dos dados em formato estruturado e legível.</li>
        </ul>
        <h3>Segurança</h3>
        <ul>
          <li>Utilizamos controles de acesso, criptografia em trânsito e armazenamento seguro das informações.</li>
          <li>As informações são protegidas contra acesso não autorizado, uso indevido ou vazamento.</li>
          <li>Manteremos procedimentos internos para revisar e aprimorar a segurança contínua dos dados.</li>
        </ul>
      `,
    },
    privacy: {
      title: "Política de Privacidade de Dados",
      body: `
        <p>Esta política descreve como a Hairstyles coleta, usa, armazena e protege os dados pessoais dos usuários da plataforma.</p>
        <h3>Dados coletados e finalidade</h3>
        <ul>
          <li>Dados cadastrais e de contato para criação do perfil do usuário e comunicação com o cliente.</li>
          <li>Dados de agendamento para disponibilizar horários, confirmar serviços e gerenciar atendimentos.</li>
          <li>Dados de endereço para envio de informações e atendimento personalizado de acordo com a visita.</li>
        </ul>
        <h3>Base legal</h3>
        <ul>
          <li>Consentimento do titular para cadastro, uso de dados e comunicações relacionadas ao serviço.</li>
          <li>Execução de contrato na prestação de serviços e agendamento de horários.</li>
          <li>Obrigação legal e interesse legítimo para cumprir regras internas e garantir a segurança da operação.</li>
        </ul>
        <h3>Direitos dos titulares</h3>
        <ul>
          <li>Acesso aos dados tratados pela Hairstylies, mediante solicitação ou confirmação de conta.</li>
          <li>Retificação de informações incorretas, incompletas ou desatualizadas.</li>
          <li>Exclusão dos dados quando houver fundamento legal ou vontade do titular.</li>
          <li>Portabilidade dos dados para outra plataforma ou utilização em outros serviços.</li>
        </ul>
        <h3>Segurança</h3>
        <ul>
          <li>Aplicamos medidas técnicas e administrativas para impedir acessos não autorizados.</li>
          <li>As credenciais e informações sensíveis são tratadas com proteção adequada e controles de acesso.</li>
          <li>Qualquer incidente relevante será tratado com atenção, registro e medidas preventivas.</li>
        </ul>
      `,
    },
  };

  const openModal = (key) => {
    const selected = policies[key];
    if (!selected) return;

    title.textContent = selected.title;
    content.innerHTML = selected.body;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  };

  const closeModal = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };

  document.querySelectorAll("[data-policy-modal]").forEach((button) => {
    button.addEventListener("click", () => openModal(button.dataset.policyModal));
  });

  closeButton.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
      closeModal();
    }
  });
}

async function setupProfile() {
  const nameEl = $("#profile-name");
  const emailEl = $("#profile-email");
  const form = $("#profile-form");

  if (!nameEl || !emailEl) return;
  if (!token()) return (location.href = "/login.html");

  try {
    const { user } = await api("/api/me", {
      headers: { Authorization: `Bearer ${token()}` },
    });

    nameEl.textContent = user.name;
    emailEl.textContent = user.email;

    if (!form) return;

    const field = (name) => form.querySelector(`[name="${name}"]`);
    field("name").value = user.name;
    field("email").value = user.email;
    field("cpf").value = user.cpf || "";
    field("birthDate").value = user.birthDate || "";
    field("phone").value = user.phone || "";

    const address = user.address || {};
    field("cep").value = address.cep || "";
    field("street").value = address.street || "";
    field("number").value = address.number || "";
    field("complement").value = address.complement || "";
    field("neighborhood").value = address.neighborhood || "";
    field("city").value = address.city || "";
    field("state").value = address.state || "";
    ["phone", "cep"].forEach((name) => {
      const input = field(name);
      if (input) input.dispatchEvent(new Event("input"));
    });

  } catch {
    localStorage.removeItem("hairstyles-token");
    location.href = "/login.html";
  }

  const logoutButton = $("#logout");
  if (logoutButton) {
    logoutButton.addEventListener("click", () => {
      localStorage.removeItem("hairstyles-token");
      location.href = "/index.html";
    });
  }
}
updateAuthLinks();
applyMasks();
loadPopular();
setupForms();
setupRecoverForm();
setupResetForm();
setupLegalModal();
setupBooking();
setupHistory();
setupProfile();
setupGlobalFooter();
