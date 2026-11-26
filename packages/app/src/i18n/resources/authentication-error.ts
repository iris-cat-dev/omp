export const authenticationError = {
  en: {
    title: {
      refresh: "Login credential refresh failed",
      missing: "Model connection unavailable",
    },
    description: {
      region: "The provider rejected the country or region of your network's exit point.",
      timeout: "The connection timed out while refreshing login credentials.",
      refresh: "Login credentials could not be refreshed at this time.",
      missing: "The current model could not obtain usable login credentials.",
    },
    guidance: {
      region:
        "Check Host settings → Proxy and make sure your network's exit point meets the provider's regional requirements.",
      connection:
        "Check Host settings → Proxy and your network connection, then retry.",
      login:
        "Check your login status in Host settings → Model connections. If you are already signed in, check your proxy and network connection.",
    },
    details: "Technical details",
  },
  "zh-CN": {
    title: {
      refresh: "登录凭据刷新失败",
      missing: "模型连接不可用",
    },
    description: {
      region: "服务商拒绝了当前网络出口所在的国家或地区。",
      timeout: "刷新登录凭据时连接超时。",
      refresh: "暂时无法刷新登录凭据。",
      missing: "当前模型未能取得可用的登录凭据。",
    },
    guidance: {
      region: "请检查主机设置 → 代理，并确认网络出口符合服务商要求。",
      connection: "请检查主机设置 → 代理或网络连接，然后重试。",
      login:
        "请在主机设置 → 模型连接检查登录状态；如已登录，请检查代理与网络。",
    },
    details: "技术详情",
  },
  ar: {
    title: {
      refresh: "تعذّر تحديث بيانات تسجيل الدخول",
      missing: "اتصال النموذج غير متاح",
    },
    description: {
      region: "رفض المزوّد البلد أو المنطقة التي يقع فيها مخرج اتصالك بالشبكة.",
      timeout: "انتهت مهلة الاتصال أثناء تحديث بيانات تسجيل الدخول.",
      refresh: "يتعذّر تحديث بيانات تسجيل الدخول حاليًا.",
      missing: "لم يتمكّن النموذج الحالي من الحصول على بيانات تسجيل دخول قابلة للاستخدام.",
    },
    guidance: {
      region:
        "تحقّق من إعدادات المضيف → الوكيل، وتأكّد من أن مخرج الشبكة يستوفي متطلبات المزوّد الإقليمية.",
      connection:
        "تحقّق من إعدادات المضيف → الوكيل ومن اتصالك بالشبكة، ثم أعد المحاولة.",
      login:
        "تحقّق من حالة تسجيل الدخول في إعدادات المضيف → اتصالات النماذج. إذا كنت مسجّل الدخول بالفعل، فتحقّق من الوكيل واتصالك بالشبكة.",
    },
    details: "التفاصيل التقنية",
  },
  es: {
    title: {
      refresh: "No se pudieron renovar las credenciales de acceso",
      missing: "Conexión del modelo no disponible",
    },
    description: {
      region: "El proveedor rechazó el país o la región del punto de salida de tu red.",
      timeout: "La conexión agotó el tiempo de espera al renovar las credenciales de acceso.",
      refresh: "No se pueden renovar las credenciales de acceso en este momento.",
      missing: "El modelo actual no pudo obtener credenciales de acceso utilizables.",
    },
    guidance: {
      region:
        "Revisa Ajustes del host → Proxy y comprueba que el punto de salida de tu red cumple los requisitos regionales del proveedor.",
      connection:
        "Revisa Ajustes del host → Proxy y tu conexión de red y vuelve a intentarlo.",
      login:
        "Comprueba tu estado de inicio de sesión en Ajustes del host → Conexiones de modelos. Si ya has iniciado sesión, revisa el proxy y la conexión de red.",
    },
    details: "Detalles técnicos",
  },
  fr: {
    title: {
      refresh: "Échec du renouvellement des identifiants de connexion",
      missing: "Connexion au modèle indisponible",
    },
    description: {
      region: "Le fournisseur a refusé le pays ou la région du point de sortie de votre réseau.",
      timeout: "Le délai de connexion a expiré lors du renouvellement des identifiants.",
      refresh: "Les identifiants de connexion ne peuvent pas être renouvelés pour le moment.",
      missing: "Le modèle actuel n’a pas pu obtenir d’identifiants de connexion utilisables.",
    },
    guidance: {
      region:
        "Vérifiez Paramètres de l’hôte → Proxy et assurez-vous que le point de sortie de votre réseau respecte les exigences régionales du fournisseur.",
      connection:
        "Vérifiez Paramètres de l’hôte → Proxy et votre connexion réseau, puis réessayez.",
      login:
        "Vérifiez votre connexion au compte dans Paramètres de l’hôte → Connexions aux modèles. Si vous êtes déjà connecté, vérifiez le proxy et la connexion réseau.",
    },
    details: "Détails techniques",
  },
  ja: {
    title: {
      refresh: "ログイン認証情報の更新に失敗しました",
      missing: "モデルに接続できません",
    },
    description: {
      region: "プロバイダーが現在のネットワークの出口にあたる国または地域を拒否しました。",
      timeout: "ログイン認証情報の更新中に接続がタイムアウトしました。",
      refresh: "現在、ログイン認証情報を更新できません。",
      missing: "現在のモデルが利用可能なログイン認証情報を取得できませんでした。",
    },
    guidance: {
      region:
        "ホスト設定 → プロキシを確認し、ネットワークの出口がプロバイダーの地域要件を満たしていることを確認してください。",
      connection:
        "ホスト設定 → プロキシとネットワーク接続を確認してから、再試行してください。",
      login:
        "ホスト設定 → モデル接続でログイン状態を確認してください。すでにログイン済みの場合は、プロキシとネットワーク接続を確認してください。",
    },
    details: "技術的な詳細",
  },
  ko: {
    title: {
      refresh: "로그인 인증 정보 갱신 실패",
      missing: "모델 연결을 사용할 수 없음",
    },
    description: {
      region: "공급자가 현재 네트워크의 출구가 위치한 국가 또는 지역을 거부했습니다.",
      timeout: "로그인 인증 정보를 갱신하는 동안 연결 시간이 초과되었습니다.",
      refresh: "현재 로그인 인증 정보를 갱신할 수 없습니다.",
      missing: "현재 모델이 사용 가능한 로그인 인증 정보를 가져오지 못했습니다.",
    },
    guidance: {
      region:
        "호스트 설정 → 프록시를 확인하고 네트워크 출구가 공급자의 지역 요구 사항을 충족하는지 확인하세요.",
      connection:
        "호스트 설정 → 프록시와 네트워크 연결을 확인한 후 다시 시도하세요.",
      login:
        "호스트 설정 → 모델 연결에서 로그인 상태를 확인하세요. 이미 로그인했다면 프록시와 네트워크 연결을 확인하세요.",
    },
    details: "기술 세부 정보",
  },
  "pt-BR": {
    title: {
      refresh: "Falha ao renovar as credenciais de login",
      missing: "Conexão com o modelo indisponível",
    },
    description: {
      region: "O provedor rejeitou o país ou a região do ponto de saída da sua rede.",
      timeout: "A conexão excedeu o tempo limite ao renovar as credenciais de login.",
      refresh: "Não foi possível renovar as credenciais de login neste momento.",
      missing: "O modelo atual não conseguiu obter credenciais de login utilizáveis.",
    },
    guidance: {
      region:
        "Verifique Configurações do host → Proxy e confira se o ponto de saída da sua rede atende aos requisitos regionais do provedor.",
      connection:
        "Verifique Configurações do host → Proxy e sua conexão de rede e tente novamente.",
      login:
        "Confira seu status de login em Configurações do host → Conexões de modelos. Se já estiver conectado, verifique o proxy e a conexão de rede.",
    },
    details: "Detalhes técnicos",
  },
  ru: {
    title: {
      refresh: "Не удалось обновить данные для входа",
      missing: "Подключение к модели недоступно",
    },
    description: {
      region: "Провайдер отклонил страну или регион выходного узла вашей сети.",
      timeout: "Истекло время ожидания соединения при обновлении данных для входа.",
      refresh: "Сейчас не удаётся обновить данные для входа.",
      missing: "Текущая модель не смогла получить пригодные для использования данные для входа.",
    },
    guidance: {
      region:
        "Проверьте Настройки хоста → Прокси и убедитесь, что выходной узел сети соответствует региональным требованиям провайдера.",
      connection:
        "Проверьте Настройки хоста → Прокси и сетевое соединение, затем повторите попытку.",
      login:
        "Проверьте состояние входа в Настройки хоста → Подключения к моделям. Если вы уже вошли, проверьте прокси и сетевое соединение.",
    },
    details: "Технические подробности",
  },
} as const;
