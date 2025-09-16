Name:           miu-client
Version:        1.0.0
Release:        1%{?dist}
Summary:        Lightweight Linux client for MIU music streaming

License:        MIT
URL:            https://miu.gacha.boo
Source0:        %{name}-%{version}.tar.gz

BuildArch:      noarch
BuildRequires:  python3-devel python3-setuptools
Requires:       python3 python3-pygame python3-pillow python3-tkinter
Recommends:     python3-pystray

%description
MIU Client is a minimal audio streaming client that connects to MIU music bot
servers. It provides live audio streaming with embedded metadata, client-side
play/pause controls, volume control, system tray integration, and minimal
resource usage. The client works without authentication and is perfect for
listening to music streams from MIU Discord bots.

%prep
%autosetup

%build
%py3_build

%install
%py3_install

%files
%{python3_sitelib}/miu_client.py
%{python3_sitelib}/miu_linux_client-%{version}-py%{python3_version}.egg-info/
%{_bindir}/miu-client

%changelog
* Mon Sep 16 2024 MIU Team <admin@miu.gacha.boo> - 1.0.0-1
- Initial release of MIU Linux Client
- Features: lightweight streaming, play/pause controls, volume control, system tray